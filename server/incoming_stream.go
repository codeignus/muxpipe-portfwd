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

	// Read the first message containing target info
	decoder := json.NewDecoder(stream)

	var message struct {
		Type string `json:"type"`
		Port int    `json:"port,omitempty"`
		Path string `json:"path,omitempty"`
	}

	if err := decoder.Decode(&message); err != nil {
		logger.Error().Err(err).Msg("Failed to decode first stream message from client")
		return
	}

	var target string
	switch message.Type {
	case "tcp":
		target = fmt.Sprintf("127.0.0.1:%d", message.Port)
		logger.Info().Msgf("Connecting to TCP port: %s", target)
	case "unix":
		target = message.Path
		logger.Info().Msgf("Connecting to Unix socket: %s", target)
	default:
		logger.Error().Msgf("Invalid target type: %s", message.Type)
		return
	}

	// Connect to the target
	conn, err := net.Dial(message.Type, target)
	if err != nil {
		logger.Error().Err(err).Msgf("Failed to connect to %s", target)
		return
	}
	defer conn.Close()

	// To avoid racing between first message and client pipe, client waits until it receives this acknowledgement
	if _, err := stream.Write([]byte("OK")); err != nil {
		logger.Error().Err(err).Msg("Failed to send OK to client")
		return
	}

	// Set up bidirectional forwarding with WaitGroup
	var wg sync.WaitGroup

	cp := func(dst, src net.Conn) {
		defer wg.Done()
		if _, err := io.Copy(dst, src); err != nil && err != io.EOF {
			logger.Error().Err(err).Msg("Copy error")
		}
		// Only close write side, don't close stream itself
		if tcpConn, ok := dst.(*net.TCPConn); ok {
			tcpConn.CloseWrite()
		}
	}

	wg.Add(2)

	// Independent go routines there is no first
	go cp(conn, stream)
	go cp(stream, conn)

	wg.Wait()

	logger.Info().Msg("Stream closed")
}
