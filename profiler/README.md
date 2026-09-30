# Profiler for Flint

Timelines of profiling captures inside your notes, like Tracy, Unreal Insights or Perfetto: one lane per thread, nested zones colored by category, frame markers, and a toolbar to search and hide categories.

````markdown
```profiler
file: .profiles/spike-frame-4812.json
```
````

It reads **Perfetto / Chrome Trace Event JSON** (`{"traceEvents": [...]}` or a plain array): complete zones (`X`), begin/end pairs (`B`/`E`), instant events (`i`) and thread and process names (`M`). Zones get their color from their `cat`.

## Using the timeline

- **Ctrl + wheel** zooms around the pointer; **drag**, **Shift + wheel** or a horizontal swipe pans. The plain wheel still scrolls the note.
- **Double-click** a zone to zoom to it. With the timeline focused, **W/S** zoom, **A/D** pan and **F** shows everything.
- Hover a zone for its name, duration, thread, category and arguments.
- **Shift + drag** selects a range: its duration and the zones that take most of it show below.
- Type in **Find zones** to dim everything else, and click a category to hide or show it.
- Frames start at the vertical lines. Events named `Frame` mark them; name others with `frames: MyMarker` in the block.

Keep captures in a hidden folder such as `.profiles/`: Flint doesn't index or list hidden folders, and the plugin can still read them. If you sync your vault, you may want to exclude that folder.

## Captures of any size

A capture loaded whole must fit in memory, so up to a few hundred megabytes. For bigger ones, split them first with [`tools/split_trace.py`](tools/split_trace.py) (needs Python 3 and `pip install ijson`):

```sh
python split_trace.py huge-capture.json /path/to/vault/.profiles/level3
```

It reads the trace as a stream, however big, and writes a folder with a `manifest.json` and one small file per slice of time (200 ms by default, `--chunk-ms` to change it). Point the block at the folder:

````markdown
```profiler
file: .profiles/level3/
```
````

Zoomed out, each thread shows how busy it was over time. Zoom in and the plugin loads the pieces in view, and drops faraway ones as you move around, so memory stays bounded.

To try the plugin without a capture of your own, [`tools/make_sample_trace.py`](tools/make_sample_trace.py) writes a made-up one.

## Developing

```sh
npm install
npm run check && npm test
FLINT_PLUGIN_DIR=/path/to/vault/.flint/plugins/profiler npm run dev
```

## License

AGPL-3.0-or-later, like Flint.
