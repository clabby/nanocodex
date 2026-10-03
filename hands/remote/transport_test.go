package main

import (
	"context"
	"strings"
	"testing"
)

func TestFrameTransportIsExplicitAndCloudflareOnly(t *testing.T) {
	for _, machine := range []string{"native", "server:host", "vm:guest", "phone:device", "cf:", ""} {
		config := hostConfig{MachineID: machine, Frames: true}
		if err := config.validateTransport(); err == nil || !strings.Contains(err.Error(), "requires WebRTC") {
			t.Fatalf("machine %q accepted JPEG live viewing: %v", machine, err)
		}
		// Both entry points reject before starting capture, reading credentials,
		// making requests, or allocating compositor infrastructure.
		if err := serveWayland(context.Background(), config); err == nil || !strings.Contains(err.Error(), "remove --frames") {
			t.Fatalf("wayland accepted %q: %v", machine, err)
		}
		if err := serveDesktopSession(context.Background(), config, "", "", false); err == nil || !strings.Contains(err.Error(), "remove --frames") {
			t.Fatalf("desktop accepted %q: %v", machine, err)
		}
		config.Frames = false
		if err := config.validateTransport(); err != nil {
			t.Fatalf("video transport rejected %q: %v", machine, err)
		}
	}
	if err := (hostConfig{MachineID: "cf:sandbox", Frames: true}).validateTransport(); err != nil {
		t.Fatalf("explicit restricted-sandbox relay rejected: %v", err)
	}
}
