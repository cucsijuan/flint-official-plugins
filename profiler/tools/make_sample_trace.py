#!/usr/bin/env python3
"""Write a made-up game capture in Trace Event JSON, to try the Flint profiler without a real one.

Usage: python make_sample_trace.py sample.json [frames]
It has a Game, a Render and four worker threads, zones colored by category, a Frame marker per
frame, and a slow frame (number 180) to find. 20000 frames make about 100 MB.
"""

import json, random, sys

random.seed(4)
events = []
def meta(tid, name, order):
    events.append({"ph": "M", "name": "thread_name", "pid": 1, "tid": tid, "args": {"name": name}})
    events.append({"ph": "M", "name": "thread_sort_index", "pid": 1, "tid": tid, "args": {"sort_index": order}})
def zone(tid, name, cat, ts, dur, **args):
    event = {"ph": "X", "name": name, "cat": cat, "pid": 1, "tid": tid, "ts": round(ts, 2), "dur": round(dur, 2)}
    if args: event["args"] = args
    events.append(event)

meta(1, "Game", 0); meta(2, "Render", 1)
for worker in range(4): meta(10 + worker, f"Worker {worker}", 2 + worker)

frames = int(sys.argv[2]) if len(sys.argv) > 2 else 300
t = 0.0
for frame in range(frames):
    spike = 3.0 if frame == 180 else 1.0
    events.append({"ph": "i", "name": "Frame", "pid": 1, "tid": 1, "ts": round(t, 2), "s": "g"})
    tick = random.uniform(9000, 12000) * spike
    zone(1, "Tick", "game", t, tick, frame=frame)
    c = t + 200
    zone(1, "Input", "game", c, 300); c += 400
    physics = random.uniform(2500, 3500) * spike
    zone(1, "Physics", "physics", c, physics)
    zone(1, "Broadphase", "physics", c + 100, physics * 0.3)
    zone(1, "Solve", "physics", c + 150 + physics * 0.3, physics * 0.55, iterations=8)
    c += physics + 200
    ai = random.uniform(1500, 2500)
    zone(1, "AI", "ai", c, ai)
    agents = random.randint(3, 7)
    for agent in range(agents):
        zone(1, "Pathfinding", "ai", c + 50 + agent * ai / agents, ai / agents * 0.8, agent=agent)
    c += ai + 200
    zone(1, "Animation", "animation", c, random.uniform(800, 1500))
    r = t + tick * 0.5
    draw = random.uniform(10000, 14000)
    zone(2, "Draw", "render", r, draw)
    rc = r + 100
    for name, share in (("Shadows", 0.2), ("GBuffer", 0.3), ("Lighting", 0.3), ("PostFX", 0.15)):
        zone(2, name, "render", rc, draw * share - 50); rc += draw * share
    for worker in range(4):
        w = t + random.uniform(0, 3000)
        while w < t + 15000:
            job = random.uniform(200, 2500)
            zone(10 + worker, random.choice(["Decompress", "Cull", "Skinning", "Audio mix"]), "jobs", w, job)
            w += job + random.uniform(100, 1500)
    t += max(16667, tick + 500)

json.dump({"traceEvents": events, "displayTimeUnit": "ms"}, open(sys.argv[1], "w"))
print(len(events), "events")
