package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
)

const maxH264Frame = 8 * 1024 * 1024
const framedH264Magic = "NCH264F1"

// Waymote enables x264 access-unit delimiters and a fixed 60 Hz encoder.
// Packetize its Annex-B stdout without decoding or re-encoding. The pipe works
// with libkrun TSI, which cannot receive the daemon's loopback UDP stream.
type h264Forwarder struct {
	encoder   codecs.H264Payloader
	sequence  uint16
	timestamp uint32
	now       func() time.Time
}

func (forwarder *h264Forwarder) read(reader io.Reader, write func(*rtp.Packet) error) error {
	if forwarder.now == nil {
		forwarder.now = time.Now
	}
	started := forwarder.now()
	var lastTicks int64
	return readH264Frames(reader, func(frame []byte) error {
		payloads := forwarder.encoder.Payload(1180, frame)
		// A compositor or busy encoder may skip frames. Advancing a fixed
		// 1/60 second per delivered frame makes playback fall behind wall time.
		elapsed := forwarder.now().Sub(started)
		// Split whole seconds before multiplication so long-running publishers
		// do not overflow a nanoseconds * 90 kHz intermediate after ~28 hours.
		ticks := max(lastTicks+1, int64(elapsed/time.Second)*90000+int64(elapsed%time.Second)*90000/int64(time.Second))
		lastTicks, forwarder.timestamp = ticks, uint32(ticks)
		for index, payload := range payloads {
			forwarder.sequence++
			packet := &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 96,
				SequenceNumber: forwarder.sequence, Timestamp: forwarder.timestamp,
				SSRC: 1, Marker: index == len(payloads)-1}, Payload: payload}
			if err := write(packet); err != nil {
				return err
			}
		}
		return nil
	})
}

func readH264Frames(reader io.Reader, emit func([]byte) error) error {
	buffered := bufio.NewReader(reader)
	prefix, _ := buffered.Peek(len(framedH264Magic))
	if string(prefix) != framedH264Magic {
		scanner := bufio.NewScanner(buffered)
		scanner.Buffer(make([]byte, 64*1024), maxH264Frame)
		scanner.Split(h264AccessUnit)
		for scanner.Scan() {
			if err := emit(scanner.Bytes()); err != nil {
				return err
			}
		}
		return scanner.Err()
	}
	_, _ = buffered.Discard(len(framedH264Magic))
	var header [4]byte
	var frame []byte
	for {
		_, err := io.ReadFull(buffered, header[:])
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		size := int(binary.BigEndian.Uint32(header[:]))
		if size < 1 || size > maxH264Frame {
			return errors.New("invalid framed H.264 size")
		}
		if cap(frame) < size {
			frame = make([]byte, size)
		} else {
			frame = frame[:size]
		}
		if _, err := io.ReadFull(buffered, frame); err != nil {
			return err
		}
		if !bytes.HasPrefix(frame, []byte{0, 0, 1}) && !bytes.HasPrefix(frame, []byte{0, 0, 0, 1}) {
			return errors.New("invalid framed H.264 payload")
		}
		if err := emit(frame); err != nil {
			return err
		}
	}
}

func h264AccessUnit(data []byte, atEOF bool) (int, []byte, error) {
	if len(data) < 5 && !atEOF {
		return 0, nil, nil
	}
	if len(data) == 0 {
		return 0, nil, nil
	}
	if !bytes.HasPrefix(data, []byte{0, 0, 1}) && !bytes.HasPrefix(data, []byte{0, 0, 0, 1}) {
		return 0, nil, errors.New("invalid H.264 capture stream")
	}
	// A start code cannot occur inside a NAL's escaped payload. Accept both
	// three- and four-byte prefixes, including when a pipe read splits them.
	if len(data) > 4 {
		if index := bytes.Index(data[4:], []byte{0, 0, 1, 9}); index >= 0 {
			end := index + 4
			if data[end-1] == 0 {
				end--
			}
			return end, data[:end], nil
		}
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}
