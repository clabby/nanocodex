package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func TestSnapshotUsesDirectJPEGAndFallsBackForPNGOnlyGrim(t *testing.T) {
	directory := t.TempDir()
	frame := image.NewRGBA(image.Rect(0, 0, 4, 2))
	var jpg, baseline bytes.Buffer
	if err := jpeg.Encode(&jpg, frame, &jpeg.Options{Quality: 65}); err != nil {
		t.Fatal(err)
	}
	if err := png.Encode(&baseline, frame); err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{
		"frame.jpg": jpg.Bytes(), "frame.png": baseline.Bytes(), "invalid.jpg": []byte("not JPEG"),
		"grim": []byte("#!/bin/sh\ncase \"$2\" in\njpeg) test \"$GRIM_JPEG\" != unsupported || exit 1; cat \"$GRIM_JPEG\";;\npng) cat \"$GRIM_PNG\";;\n*) exit 2;;\nesac\n"),
	}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(directory, name), data, 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("GRIM_PNG", filepath.Join(directory, "frame.png"))
	for _, variant := range []string{"frame.jpg", "invalid.jpg", "unsupported"} {
		t.Run(variant, func(t *testing.T) {
			path := variant
			if variant != "unsupported" {
				path = filepath.Join(directory, variant)
			}
			t.Setenv("GRIM_JPEG", path)
			result := snapshotDesktop(context.Background(), 4, 2)
			if result.Status != "ok" || result.Width != 4 || result.Height != 2 {
				t.Fatalf("capture failed: %s", result.Status)
			}
			data, err := base64.StdEncoding.DecodeString(result.JPEG)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
				t.Fatal(err)
			}
			if variant == "frame.jpg" && !bytes.Equal(data, jpg.Bytes()) {
				t.Fatal("direct JPEG was re-encoded")
			}
		})
	}
}
