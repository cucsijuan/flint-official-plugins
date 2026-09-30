#!/usr/bin/env python3
"""Split a Perfetto / Chrome Trace Event JSON capture into pieces the Flint profiler loads on demand.

Captures of several gigabytes can't be loaded whole. This reads the trace as a stream and writes a
folder with a manifest.json (threads, categories, frames, an overview) and one small file per slice
of time. Point a profiler block at that folder:

    ```profiler
    file: .profiles/level3/
    ```

Usage: python split_trace.py capture.json output-folder [--chunk-ms 200] [--frames Frame]
Needs the ijson package: pip install ijson
"""

import argparse
import json
import os
import shutil
import sys
import tempfile
from collections import defaultdict

try:
    import ijson
except ImportError:
    sys.exit("This script needs the ijson package: pip install ijson")

OVERVIEW_BUCKETS_PER_CHUNK = 4
FLUSH_EVERY_ZONES = 200_000


class Interner:
    """Keeps each distinct string once and refers to it by index."""

    def __init__(self):
        self.values = []
        self.indexes = {}

    def __call__(self, value):
        if value not in self.indexes:
            self.indexes[value] = len(self.values)
            self.values.append(value)
        return self.indexes[value]


def events_of(path):
    """Yields the trace's events, whether it's `{"traceEvents": [...]}` or a plain array."""
    with open(path, "rb") as file:
        first = file.read(1)
        while first.isspace():
            first = file.read(1)
        file.seek(0)
        prefix = "item" if first == b"[" else "traceEvents.item"
        yield from ijson.items(file, prefix, use_float=True)


def split(source, output, chunk_us, frame_marker):
    names, categories = Interner(), Interner()
    thread_names, process_names, sort_indexes = {}, {}, {}
    track_indexes = {}
    open_zones = defaultdict(list)
    frames = []
    start, end = float("inf"), float("-inf")
    buckets = defaultdict(list)
    pending = 0
    work = tempfile.mkdtemp(prefix="flint-trace-")

    def track_of(event):
        key = f"{event.get('pid', 0)}:{event.get('tid', 0)}"
        if key not in track_indexes:
            track_indexes[key] = len(track_indexes)
        return track_indexes[key]

    def flush():
        nonlocal pending
        for chunk, zones in buckets.items():
            with open(os.path.join(work, f"{chunk}.jsonl"), "a", encoding="utf-8") as file:
                file.writelines(json.dumps(zone, separators=(",", ":")) + "\n" for zone in zones)
        buckets.clear()
        pending = 0

    def add(event, zone_start, zone_end, args):
        nonlocal start, end, pending
        zone_end = max(zone_end, zone_start)
        zone = [track_of(event), zone_start, zone_end, names(event.get("name", "")), categories(event.get("cat", ""))]
        if args:
            zone.append(args)
        # A zone goes into every slice it overlaps, so nesting works out inside each slice.
        for chunk in range(int(zone_start // chunk_us), int(zone_end // chunk_us) + 1):
            buckets[chunk].append(zone)
            pending += 1
        start, end = min(start, zone_start), max(end, zone_end)
        if pending >= FLUSH_EVERY_ZONES:
            flush()

    for event in events_of(source):
        phase = event.get("ph")
        ts = float(event.get("ts", 0))
        if phase == "X":
            add(event, ts, ts + float(event.get("dur", 0)), event.get("args"))
            if event.get("name") == frame_marker:
                frames.append(ts)
        elif phase == "B":
            open_zones[track_of(event)].append(event)
        elif phase == "E":
            stack = open_zones[track_of(event)]
            if stack:
                begin = stack.pop()
                args = {**(begin.get("args") or {}), **(event.get("args") or {})}
                add(begin, float(begin.get("ts", 0)), ts, args)
        elif phase in ("i", "I"):
            if event.get("name") == frame_marker:
                frames.append(ts)
            start, end = min(start, ts), max(end, ts)
        elif phase == "M":
            key = f"{event.get('pid', 0)}:{event.get('tid', 0)}"
            name = str((event.get("args") or {}).get("name", ""))
            if event.get("name") == "thread_name":
                thread_names[key] = name
            elif event.get("name") == "process_name":
                process_names[str(event.get("pid", 0))] = name
            elif event.get("name") == "thread_sort_index":
                sort_indexes[key] = (event.get("args") or {}).get("sort_index", 0)
    flush()

    if start == float("inf"):
        sys.exit("No zones found in the capture.")

    os.makedirs(os.path.join(output, "chunks"), exist_ok=True)
    depths = defaultdict(int)
    bucket_us = chunk_us / OVERVIEW_BUCKETS_PER_CHUNK
    bucket_count = int((end - start) // bucket_us) + 1
    overview = defaultdict(lambda: [0.0] * bucket_count)
    chunks = []

    for file_name in sorted(os.listdir(work), key=lambda name: int(name.split(".")[0])):
        chunk = int(file_name.split(".")[0])
        with open(os.path.join(work, file_name), encoding="utf-8") as file:
            zones = [json.loads(line) for line in file]
        zones.sort(key=lambda zone: (zone[0], zone[1], -zone[2]))
        written = []
        open_by_track = defaultdict(list)
        chunk_start, chunk_end = chunk * chunk_us, (chunk + 1) * chunk_us
        for zone in zones:
            stack = open_by_track[zone[0]]
            while stack and stack[-1] <= zone[1]:
                stack.pop()
            depth = len(stack)
            stack.append(zone[2])
            depths[zone[0]] = max(depths[zone[0]], depth + 1)
            written.append([zone[0], zone[1], zone[2], depth, *zone[3:]])
            if depth == 0:
                # Count busy time per overview bucket, only the part inside this slice.
                busy_from, busy_to = max(zone[1], chunk_start), min(zone[2], chunk_end)
                bucket = int((busy_from - start) // bucket_us)
                while busy_from < busy_to and bucket < bucket_count:
                    bucket_end = start + (bucket + 1) * bucket_us
                    overview[zone[0]][bucket] += min(busy_to, bucket_end) - busy_from
                    busy_from = bucket_end
                    bucket += 1
        name = f"chunks/{chunk:06d}.json"
        with open(os.path.join(output, name), "w", encoding="utf-8") as file:
            json.dump({"zones": written}, file, separators=(",", ":"))
        chunks.append({"file": name, "start": chunk_start, "end": chunk_end, "zones": len(written)})

    shutil.rmtree(work, ignore_errors=True)
    many_processes = len({key.split(":")[0] for key in track_indexes}) > 1
    tracks = []
    for key, index in sorted(track_indexes.items(), key=lambda item: item[1]):
        pid, tid = key.split(":")
        thread = thread_names.get(key, f"Thread {tid}")
        name = f"{process_names.get(pid, 'Process ' + pid)} · {thread}" if many_processes else thread
        tracks.append({
            "name": name,
            "sortIndex": sort_indexes.get(key, int(tid) if tid.lstrip("-").isdigit() else 0),
            "depth": depths[index],
            "overview": [round(min(busy / bucket_us, 1), 3) for busy in overview[index]],
        })
    manifest = {
        "format": "flint-profile",
        "version": 1,
        "start": start,
        "end": end,
        "chunkDuration": chunk_us,
        "overviewBucket": bucket_us,
        "names": names.values,
        "categories": categories.values,
        "frames": sorted(frames),
        "tracks": tracks,
        "chunks": chunks,
    }
    with open(os.path.join(output, "manifest.json"), "w", encoding="utf-8") as file:
        json.dump(manifest, file, separators=(",", ":"))
    zone_count = sum(chunk["zones"] for chunk in chunks)
    print(f"Wrote {len(chunks)} pieces ({zone_count} zones) and manifest.json to {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("capture", help="a Perfetto / Chrome Trace Event JSON file")
    parser.add_argument("output", help="the folder to write, ideally inside your vault's .profiles/")
    parser.add_argument("--chunk-ms", type=float, default=200, help="length of each piece (default 200 ms)")
    parser.add_argument("--frames", default="Frame", help="name of the events that mark frames (default Frame)")
    arguments = parser.parse_args()
    split(arguments.capture, arguments.output, arguments.chunk_ms * 1000, arguments.frames)


if __name__ == "__main__":
    main()
