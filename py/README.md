# Python libraries

[`bindings`](bindings) is the publishable Maturin/PyO3 `nanocodex` package.
Its Rust extension is a thin consumer of the same owned agent lifecycle as the
native and JavaScript libraries.

Use existing provider SDKs through the Nanocodex connector base URLs without
installing the native bindings. The [Spotipy example](../examples/python/spotify_proxy.py)
uses a Connect grant and the standard `current_user_playlists` / `next` methods.
Run it with `uv run examples/python/spotify_proxy.py` from the repository root.
