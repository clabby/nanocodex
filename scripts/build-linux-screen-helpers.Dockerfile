# glibc 2.35 build baseline; the loader and complete runtime closure travel too.
FROM ubuntu:22.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git xz-utils python3 build-essential pkg-config binutils \
    meson ninja-build libwayland-dev libwayland-bin libxkbcommon-dev libpixman-1-dev libpng-dev \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/build-linux-screen-helpers.py /opt/build-linux-screen-helpers.py
COPY scripts/tests/linux-screen-helpers-bundle.py /opt/tests/linux-screen-helpers-bundle.py
ENTRYPOINT ["python3", "/opt/build-linux-screen-helpers.py"]
