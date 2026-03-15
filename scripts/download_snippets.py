#!/usr/bin/env python3
"""
80s Music Quiz — Snippet Downloader
====================================
Downloads 5-second MP3 clips from YouTube for all 200 songs.

Requirements:
  pip install yt-dlp
  brew install ffmpeg   (or apt install ffmpeg)

Usage:
  python download_snippets.py                    # download all missing
  python download_snippets.py --start 0 --end 9  # download first 10
  python download_snippets.py --id song_001      # download one song
  python download_snippets.py --force            # re-download all
  python download_snippets.py --check            # list missing files only
  python download_snippets.py --validate         # check existing files for problems
  python download_snippets.py --fix              # re-download files that fail validation
"""

import subprocess
import json
import os
import re
import sys
import time
import glob
import argparse
import tempfile
import shutil
import urllib.request

SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR   = os.path.join(SCRIPT_DIR, "..", "public")
SONGS_FILE   = os.path.join(PUBLIC_DIR, "songs.json")
SNIPPETS_DIR = os.path.join(PUBLIC_DIR, "snippets")

MIN_FILE_SIZE  = 5_000    # bytes — anything smaller is suspect
MIN_DURATION   = 1.5      # seconds — shorter means something went wrong
SILENCE_THRESH = -50.0    # dB — mean volume below this = silent


# ─── Network check ───────────────────────────────────────────────────────────

def check_network(timeout=5):
    """Return True if internet is reachable."""
    for host in ["https://www.google.com", "https://www.youtube.com"]:
        try:
            urllib.request.urlopen(host, timeout=timeout)
            return True
        except Exception:
            continue
    return False


# ─── Dependency checks ───────────────────────────────────────────────────────

def check_command(cmd):
    return shutil.which(cmd) is not None

def check_dependencies():
    ok = True
    for dep in ["yt-dlp", "ffmpeg", "ffprobe"]:
        if check_command(dep):
            print(f"  ✓ {dep} found")
        else:
            print(f"  ✗ {dep} NOT found — install it first")
            ok = False
    return ok


# ─── File validation ─────────────────────────────────────────────────────────

def get_audio_info(filepath):
    """
    Returns dict with 'duration' (float, seconds) and 'codec' using ffprobe.
    Returns None on failure.
    """
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_streams",
        filepath,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    for stream in data.get("streams", []):
        if stream.get("codec_type") == "audio":
            return {
                "duration": float(stream.get("duration", 0) or 0),
                "codec":    stream.get("codec_name", "unknown"),
                "bitrate":  int(stream.get("bit_rate", 0) or 0),
            }
    return None


def get_mean_volume(filepath):
    """
    Returns mean volume in dB using ffmpeg volumedetect filter.
    Returns None if it cannot be determined.
    """
    cmd = [
        "ffmpeg", "-i", filepath,
        "-af", "volumedetect",
        "-f", "null", "-",
        "-loglevel", "info",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    match = re.search(r"mean_volume:\s*([-\d.]+)\s*dB", result.stderr)
    if match:
        return float(match.group(1))
    return None


def validate_snippet(filepath, expected_duration=5):
    """
    Check a snippet for common problems.
    Returns (ok: bool, issues: list[str])
    """
    issues = []

    # 1. Existence
    if not os.path.exists(filepath):
        return False, ["File does not exist"]

    # 2. Size
    size = os.path.getsize(filepath)
    if size < MIN_FILE_SIZE:
        issues.append(f"File too small ({size:,} bytes) — likely corrupt or empty")
        return False, issues   # no point checking further

    # 3. Audio metadata
    info = get_audio_info(filepath)
    if info is None:
        issues.append("Cannot read audio info — file may be corrupt (ffprobe failed)")
        return False, issues

    duration = info["duration"]
    if duration < MIN_DURATION:
        issues.append(
            f"Duration too short ({duration:.2f}s, expected ~{expected_duration}s)"
        )

    # 4. Silence detection
    mean_vol = get_mean_volume(filepath)
    if mean_vol is not None and mean_vol < SILENCE_THRESH:
        issues.append(
            f"Audio is silent or near-silent (mean volume {mean_vol:.1f} dB)"
        )
    elif mean_vol is None:
        issues.append("Could not measure volume (volumedetect failed)")

    ok = len(issues) == 0
    return ok, issues


# ─── Downloader ──────────────────────────────────────────────────────────────

def _try_download(query, temp_base, verbose=False):
    """Run yt-dlp with a given search query. Returns path to downloaded file or None."""
    cmd_dl = [
        "yt-dlp",
        f"ytsearch1:{query}",
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "5",
        "-o", f"{temp_base}.%(ext)s",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
    ]
    if verbose:
        cmd_dl = [c for c in cmd_dl if c not in ("--quiet", "--no-warnings")]

    try:
        result = subprocess.run(cmd_dl, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return None, "Download timed out"

    if result.returncode != 0:
        return None, result.stderr.strip()[:200]

    # Locate the file yt-dlp produced
    for ext in ["mp3", "m4a", "webm", "opus", "ogg"]:
        candidate = f"{temp_base}.{ext}"
        if os.path.exists(candidate):
            return candidate, None

    matches = glob.glob(f"{temp_base}.*")
    if matches:
        return matches[0], None

    return None, "Downloaded file not found on disk"


def _fallback_query(original_query):
    """Generate a simpler fallback search query by stripping 'official' keywords."""
    q = original_query
    for word in ["official video", "official", "official audio"]:
        q = q.replace(word, "").strip()
    return q


def download_snippet(song, snippets_dir, temp_dir, verbose=False):
    song_id  = song["id"]
    filename = song["filename"]
    out_path = os.path.join(snippets_dir, filename)
    start    = song["start_time"]
    duration = song.get("duration", 5)

    queries = [
        song["search_query"],
        _fallback_query(song["search_query"]),
        f"{song['title']} {song['artist']} {song['year']}",
    ]
    # Deduplicate while preserving order
    seen = set()
    queries = [q for q in queries if not (q in seen or seen.add(q))]

    temp_file = None
    last_error = "unknown error"

    for attempt, query in enumerate(queries, 1):
        temp_base = os.path.join(temp_dir, f"tmp_{song_id}_a{attempt}")
        if verbose:
            print(f"    → Query [{attempt}]: {query}")

        temp_file, err = _try_download(query, temp_base, verbose=verbose)
        if temp_file:
            break
        last_error = err
        if verbose:
            print(f"    ✗ attempt {attempt} failed: {err}")
        time.sleep(1)

    if not temp_file:
        print(f"  [DL FAIL] {song['title']} — {last_error}")
        return False

    # Trim with ffmpeg
    cmd_trim = [
        "ffmpeg",
        "-ss", str(start),
        "-t",  str(duration),
        "-i",  temp_file,
        "-acodec", "libmp3lame",
        "-ab",     "128k",
        "-ar",     "44100",
        out_path,
        "-y",
        "-loglevel", "error",
    ]

    try:
        result = subprocess.run(cmd_trim, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        print(f"  [TRIM TIMEOUT] {song['title']}")
        if os.path.exists(temp_file):
            os.remove(temp_file)
        return False
    finally:
        if os.path.exists(temp_file):
            os.remove(temp_file)

    if result.returncode != 0 or not os.path.exists(out_path):
        print(f"  [TRIM FAIL] {song['title']} — {result.stderr.strip()[:120]}")
        return False

    # Post-download validation
    ok, issues = validate_snippet(out_path, expected_duration=duration)
    size_kb = os.path.getsize(out_path) // 1024
    if ok:
        print(f"  [OK] {song['title']} — {song['artist']} ({size_kb} KB)")
    else:
        print(f"  [WARN] {song['title']} — {song['artist']} ({size_kb} KB) — issues found:")
        for issue in issues:
            print(f"         • {issue}")
        # Keep the file but warn — caller decides whether to retry

    return True   # downloaded (even if quality warnings)


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Download & validate 80s quiz snippets")
    parser.add_argument("--start",    type=int,   default=None, help="Start index (0-based)")
    parser.add_argument("--end",      type=int,   default=None, help="End index (inclusive)")
    parser.add_argument("--id",       type=str,   default=None, help="Single song id, e.g. song_001")
    parser.add_argument("--force",    action="store_true",      help="Re-download even if file exists")
    parser.add_argument("--check",    action="store_true",      help="List missing files only, no download")
    parser.add_argument("--validate", action="store_true",      help="Check existing files for problems (size, duration, silence)")
    parser.add_argument("--fix",      action="store_true",      help="Re-download files that fail validation")
    parser.add_argument("--delay",    type=float, default=2.0,  help="Delay between downloads (default 2s)")
    parser.add_argument("--verbose",  action="store_true",      help="Show yt-dlp output and query details")
    args = parser.parse_args()

    print("\n════════════════════════════════════════")
    print("  80s Music Quiz — Snippet Downloader")
    print("════════════════════════════════════════\n")

    # ── Dependencies ──
    print("Checking dependencies…")
    if not check_dependencies():
        print("\nInstall missing tools and re-run.")
        sys.exit(1)
    print()

    # ── Network ──
    print("Checking network…")
    if check_network():
        print("  ✓ Internet reachable\n")
    else:
        print("  ✗ No internet connection detected!")
        if not (args.validate or args.check):
            print("  Cannot download without network. Check your connection and retry.")
            sys.exit(1)
        print("  Continuing in validate/check-only mode.\n")

    # ── Load songs ──
    if not os.path.exists(SONGS_FILE):
        print(f"ERROR: songs.json not found at {SONGS_FILE}")
        sys.exit(1)

    with open(SONGS_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)

    songs = data["songs"]

    if args.id:
        songs = [s for s in songs if s["id"] == args.id]
        if not songs:
            print(f"ERROR: song id '{args.id}' not found in songs.json")
            sys.exit(1)

    if args.start is not None:
        songs = songs[args.start:]
    if args.end is not None:
        limit = args.end - (args.start or 0) + 1
        songs = songs[:limit]

    os.makedirs(SNIPPETS_DIR, exist_ok=True)

    # ══════════════════════════════════════════
    # MODE: --check
    # ══════════════════════════════════════════
    if args.check:
        missing = [s for s in songs
                   if not os.path.exists(os.path.join(SNIPPETS_DIR, s["filename"]))]
        if not missing:
            print(f"✓ All {len(songs)} snippets present.")
        else:
            print(f"Missing {len(missing)} / {len(songs)} snippets:")
            for s in missing:
                print(f"  {s['id']}  {s['title']} — {s['artist']}")
        return

    # ══════════════════════════════════════════
    # MODE: --validate  (or --fix which implies validate)
    # ══════════════════════════════════════════
    if args.validate or args.fix:
        print(f"Validating {len(songs)} snippet(s)…\n")
        bad_songs  = []
        good_count = 0
        miss_count = 0

        for song in songs:
            path = os.path.join(SNIPPETS_DIR, song["filename"])
            if not os.path.exists(path):
                print(f"  [MISSING]  {song['id']}  {song['title']} — {song['artist']}")
                bad_songs.append(song)
                miss_count += 1
                continue

            ok, issues = validate_snippet(path, expected_duration=song.get("duration", 5))
            if ok:
                good_count += 1
                if args.verbose:
                    size_kb = os.path.getsize(path) // 1024
                    info = get_audio_info(path)
                    dur  = f"{info['duration']:.2f}s" if info else "?"
                    print(f"  [OK]       {song['id']}  {song['title']} ({size_kb} KB, {dur})")
            else:
                size_kb = os.path.getsize(path) // 1024 if os.path.exists(path) else 0
                print(f"  [BAD]      {song['id']}  {song['title']} — {song['artist']}  ({size_kb} KB)")
                for issue in issues:
                    print(f"             • {issue}")
                bad_songs.append(song)

        print(f"\n─────────────────────────────────────────")
        print(f"  Validation: {good_count} OK, {len(bad_songs)} problematic, {miss_count} missing")
        print(f"─────────────────────────────────────────\n")

        if not bad_songs:
            print("✓ All files look good!\n")
            return

        if not args.fix:
            print("Re-run with --fix to automatically re-download problematic files.")
            return

        # ── --fix: re-download bad files ──
        print(f"\nRe-downloading {len(bad_songs)} problematic file(s)…\n")
        fixed   = 0
        unfixed = []

        with tempfile.TemporaryDirectory() as temp_dir:
            for i, song in enumerate(bad_songs, 1):
                print(f"[{i}/{len(bad_songs)}] {song['title']} — {song['artist']}")
                # Remove old bad file
                old_path = os.path.join(SNIPPETS_DIR, song["filename"])
                if os.path.exists(old_path):
                    os.remove(old_path)

                success = download_snippet(song, SNIPPETS_DIR, temp_dir, verbose=args.verbose)
                if success:
                    fixed += 1
                else:
                    unfixed.append(f"{song['id']} — {song['title']} — {song['artist']}")

                if i < len(bad_songs) and args.delay > 0:
                    time.sleep(args.delay)

        print(f"\n─────────────────────────────────────────")
        print(f"  Fixed: {fixed}, Still failing: {len(unfixed)}")
        if unfixed:
            print("\n  Could not fix:")
            for u in unfixed:
                print(f"    {u}")
        print(f"─────────────────────────────────────────\n")
        return

    # ══════════════════════════════════════════
    # MODE: download (default)
    # ══════════════════════════════════════════
    total    = len(songs)
    skipped  = 0
    ok_count = 0
    failed   = 0
    failures = []

    print(f"Downloading {total} snippet(s) → {SNIPPETS_DIR}\n")

    with tempfile.TemporaryDirectory() as temp_dir:
        for i, song in enumerate(songs, 1):
            out_path = os.path.join(SNIPPETS_DIR, song["filename"])

            if not args.force and os.path.exists(out_path):
                if args.verbose:
                    print(f"  [SKIP] {song['title']} — {song['artist']} (exists)")
                skipped += 1
                continue

            print(f"[{i}/{total}] {song['title']} — {song['artist']} ({song['year']})")
            success = download_snippet(song, SNIPPETS_DIR, temp_dir, verbose=args.verbose)

            if success:
                ok_count += 1
            else:
                failed += 1
                failures.append(f"{song['id']} — {song['title']} — {song['artist']}")

            if i < total and args.delay > 0:
                time.sleep(args.delay)

    print(f"\n─────────────────────────────────────────")
    print(f"  Done: {ok_count} downloaded, {skipped} skipped, {failed} failed")
    if failures:
        print("\n  Failed (re-run with --fix to retry):")
        for f in failures:
            print(f"    {f}")
    print(f"─────────────────────────────────────────\n")


if __name__ == "__main__":
    main()
