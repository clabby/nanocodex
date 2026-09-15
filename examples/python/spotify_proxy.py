# /// script
# requires-python = ">=3.11"
# dependencies = ["spotipy==2.26.0"]
# ///
"""Use ordinary Spotipy methods with a user's Nanocodex Connect grant.

Run: uv run examples/python/spotify_proxy.py
Set NANOCODEX_GRANT_TOKEN to the app grant returned by Connect login.
"""

import os

import requests
import spotipy


def spotify_client(grant_token: str, *, origin: str = "https://nanocodex.gakonst.workers.dev",
                   connection_id: str | None = None) -> spotipy.Spotify:
    session = requests.Session()
    if connection_id:
        session.headers["X-Nanocodex-Connector-Connection"] = connection_id
    client = spotipy.Spotify(auth=grant_token, requests_session=session,
                             retries=0, status_retries=0, requests_timeout=30)
    client.prefix = origin.rstrip("/") + "/connectors/spotify/v1/"
    return client


if __name__ == "__main__":
    spotify = spotify_client(
        os.environ["NANOCODEX_GRANT_TOKEN"],
        origin=os.environ.get("NANOCODEX_ORIGIN", "https://nanocodex.gakonst.workers.dev"),
        connection_id=os.environ.get("NANOCODEX_SPOTIFY_CONNECTION_ID"),
    )
    page = spotify.current_user_playlists(limit=20)
    while page:
        for playlist in page["items"]:
            print(playlist["name"])
        page = spotify.next(page)
