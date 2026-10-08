# syntax=docker/dockerfile:1
# Static Cloudflare sandbox image: OS packages, language toolchains and the
# creative/document toolkit. Cloudflare sandboxes are execution environments,
# not Hands: nothing here compiles or ships Nanocodex. Only edits to this file,
# the toolkit or check-dev-stack.sh rebuild the image.

# Linux toolchains; Apple SDKs and xcodebuild remain on macOS CI.
FROM golang:1.26.5-bookworm AS go-toolchain
# Explicit upstream refresh without disabling normal source-layer reuse.
ARG NANOCODEX_IMAGE_CACHE_EPOCH=1
RUN test -n "$NANOCODEX_IMAGE_CACHE_EPOCH"
FROM swift:6.3.3-jammy AS swift-toolchain
# Explicit upstream refresh without disabling normal source-layer reuse.
ARG NANOCODEX_IMAGE_CACHE_EPOCH=1
RUN test -n "$NANOCODEX_IMAGE_CACHE_EPOCH"
FROM node:24.19.0-bookworm-slim AS node-toolchain
# Explicit upstream refresh without disabling normal source-layer reuse.
ARG NANOCODEX_IMAGE_CACHE_EPOCH=1
RUN test -n "$NANOCODEX_IMAGE_CACHE_EPOCH"
RUN npm install --global pnpm@11.25.0

FROM docker.io/cloudflare/sandbox:0.12.4
# Explicit upstream refresh without disabling normal source-layer reuse.
ARG NANOCODEX_IMAGE_CACHE_EPOCH=1
RUN test -n "$NANOCODEX_IMAGE_CACHE_EPOCH"
COPY --from=swift-toolchain /usr /opt/swift/usr
COPY --from=node-toolchain /usr/local /opt/node
COPY --from=go-toolchain /usr/local/go /usr/local/go

COPY --from=ghcr.io/astral-sh/uv:0.8.11 /uv /uvx /usr/local/bin/

ENV DEBIAN_FRONTEND=noninteractive \
    RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    CARGO_TARGET_DIR=/tmp/nanocodex-cargo-target \
    PATH=/opt/node/bin:/opt/cargo/bin:/opt/swift/usr/bin:/usr/local/go/bin:${PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        clang \
        cmake \
        curl \
        fd-find \
        gh \
        git \
        git-lfs \
        jq \
        less \
        fonts-dejavu-core \
        libssl-dev \
        libcurl4-openssl-dev \
        libedit2 \
        libgcc-11-dev \
        libpython3-dev \
        libsqlite3-0 \
        libstdc++-11-dev \
        libxml2-dev \
        libz3-dev \
        python3-lldb-13 \
        tzdata \
        zlib1g-dev \
        musl-tools \
        ninja-build \
        openssh-client \
        pkg-config \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        rsync \
        shellcheck \
        sqlite3 \
        tmux \
        tree \
        unzip \
        vim-tiny \
        wget \
        zip \
    && apt-get clean \
    && rm -rf /var/cache/apt/* /var/lib/apt/lists/*

# Ubuntu 22.04's chromium-browser package requires Snap, which is unavailable
# in the Sandbox container. Install Google's native AMD64 Debian package.
RUN curl --fail --location --proto '=https' --tlsv1.2 \
        --retry 3 --retry-all-errors --retry-delay 2 \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
        -o /tmp/google-chrome.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
    && google-chrome --version \
    && apt-get clean \
    && rm -rf /tmp/google-chrome.deb /var/cache/apt/* /var/lib/apt/lists/*

RUN ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --default-toolchain 1.97.0 \
    && rustup component add clippy rustfmt \
    && rustup target add wasm32-unknown-unknown x86_64-unknown-linux-musl \
    && cargo install --locked wasm-bindgen-cli --version 0.2.126 \
    && rm -rf "$CARGO_TARGET_DIR" \
    && cargo --version \
    && rustc --version \
    && pnpm --version \
    && uv --version

# Creative, document, OCR, and scientific tools are available without a download.
COPY .generated/toolkit/python.txt /opt/hand-toolkit/python.txt
RUN apt-get update && apt-get install -y --no-install-recommends \
        blender ffmpeg pulseaudio pulseaudio-utils imagemagick inkscape libreoffice pandoc \
        poppler-utils qpdf ghostscript tesseract-ocr tesseract-ocr-eng graphviz \
        fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && uv venv --python /usr/bin/python3 --seed /opt/hand-python \
    && /opt/hand-python/bin/pip install --no-cache-dir \
        numpy==2.2.6 scipy==1.15.3 pandas==2.3.3 matplotlib==3.10.6 \
        sympy==1.14.0 Pillow==11.3.0 lxml==6.0.2 openpyxl==3.1.5 reportlab==4.4.4 \
        -r /opt/hand-toolkit/python.txt
COPY .generated/toolkit/check.py .generated/toolkit/install-paths.sh /opt/hand-toolkit/
RUN sh /opt/hand-toolkit/install-paths.sh \
    && chmod 0755 /opt/hand-toolkit/check.py \
    && ln -s /opt/hand-toolkit/check.py /usr/local/bin/nanocodex-check-hand-toolkit
ENV PATH=/opt/hand-python/bin:${PATH}

COPY --chmod=0755 scripts/check-dev-stack.sh /usr/local/bin/nanocodex-check-dev-stack
ARG CI_TESTS_ENABLED=true
RUN if [ "$CI_TESTS_ENABLED" != "false" ]; then sh /usr/local/bin/nanocodex-check-dev-stack; fi

EXPOSE 3000
EXPOSE 5173
EXPOSE 8000
EXPOSE 8080
