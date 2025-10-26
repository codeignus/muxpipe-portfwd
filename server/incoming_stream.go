package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"

	"github.com/hashicorp/yamux"
)

func handleIncomingStream(stream *yamux.Stream) {
	defer stream.Close()

	streamID := stream.StreamID()
	logger.Debug().Uint32("streamId", streamID).Msg("Reading target info")

	// Read the first message containing target info
	decoder := json.NewDecoder(stream)

	var message struct {
		Type string `json:"type"`
		Port int    `json:"port,omitempty"`
		Path string `json:"path,omitempty"`
	}

	if err := decoder.Decode(&message); err != nil {
		logger.Error().Err(err).Uint32("streamId", streamID).Msg("Failed to decode target info")
		return
	}

	var target string
	switch message.Type {
	case "tcp":
		target = fmt.Sprintf("127.0.0.1:%d", message.Port)
		logger.Info().Uint32("streamId", streamID).Str("type", "tcp").Int("port", message.Port).Msg("Connecting to target")
	case "unix":
		target = message.Path
		logger.Info().Uint32("streamId", streamID).Str("type", "unix").Str("path", message.Path).Msg("Connecting to target")
	default:
		logger.Error().Uint32("streamId", streamID).Str("type", message.Type).Msg("Invalid target type")
		return
	}

	// Connect to the target
	conn, err := net.Dial(message.Type, target)
	if err != nil {
		logger.Error().Err(err).Uint32("streamId", streamID).Str("target", target).Msg("Failed to connect to target")
		return
	}
	defer conn.Close()

	logger.Debug().Uint32("streamId", streamID).Str("target", target).Msg("Connected, sending acknowledgement")

	// To avoid racing between first message and client pipe, client waits until it receives this acknowledgement
	if _, err := stream.Write([]byte("OK")); err != nil {
		logger.Error().Err(err).Uint32("streamId", streamID).Msg("Failed to send acknowledgement")
		return
	}

	logger.Debug().Uint32("streamId", streamID).Msg("Starting bidirectional forwarding")

	// Set up bidirectional forwarding with WaitGroup
	var wg sync.WaitGroup

	cp := func(dst, src net.Conn, direction string) {
		defer wg.Done()
		n, err := io.Copy(dst, src)
		if err != nil && err != io.EOF {
			logger.Error().Err(err).Uint32("streamId", streamID).Str("direction", direction).Msg("Copy error")
		} else {
			logger.Debug().Uint32("streamId", streamID).Str("direction", direction).Int64("bytes", n).Msg("Copy completed")
		}
		// Only close write side, don't close stream itself
		if tcpConn, ok := dst.(*net.TCPConn); ok {
			tcpConn.CloseWrite()
		}
	}

	wg.Add(2)

	// Independent go routines there is no first
	go cp(conn, stream, "client->target")
	go cp(stream, conn, "target->client")

	wg.Wait()

	logger.Info().Uint32("streamId", streamID).Msg("Stream closed")
}
