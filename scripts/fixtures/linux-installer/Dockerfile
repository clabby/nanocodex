FROM ubuntu:24.04
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv sudo ca-certificates libpulse0 libxkbcommon0 xvfb openbox xterm xauth fonts-dejavu-core ffmpeg libssl3 python3 nodejs node-ws && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
