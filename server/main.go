package main

import (
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/rs/zerolog"
)

var logger zerolog.Logger

func init() {
	logger = zerolog.New(os.Stderr).
		With().
		Timestamp().
		Str("source", "server").
		Logger()
}

func main() {
	logger.Info().Msg("Starting server...")

	// Handle graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	session := createYamuxSession()
	defer session.Close()

	// Accept streams in a goroutine
	streamChan := make(chan *yamux.Stream)
	errChan := make(chan error, 1)

	go func() {
		for {
			stream, err := session.AcceptStream()
			if err != nil {
				errChan <- err
				return
			}
			streamChan <- stream
		}
	}()

	// Select loop to coordinate events
	for {
		select {
		case stream := <-streamChan:
			logger.Info().Msg("New stream accepted")
			go handleIncomingStream(stream)

		case err := <-errChan:
			if err != io.EOF {
				logger.Error().Err(err).Msg("Error accepting stream")
			}
			logger.Info().Msg("Server Shutting down")
			return

		case sig := <-sigChan:
			logger.Info().Msgf("Received signal %v, shutting down", sig)
			return
		}
	}
}

func createYamuxSession() *yamux.Session {
	config := yamux.DefaultConfig()
	config.EnableKeepAlive = true
	config.KeepAliveInterval = 30 * time.Second // Optional but good
	config.LogOutput = os.Stderr

	// Wrap stdin/stdout as a ReadWriteCloser
	stdio := &stdioConn{
		reader: os.Stdin,
		writer: os.Stdout,
	}

	// Create a Yamux server session
	session, err := yamux.Server(stdio, config)
	if err != nil {
		logger.Fatal().Err(err).Msg("Failed to initialize Session")
	}

	logger.Info().Msg("Session is created & Server is ready to accept streams")

	return session
}

// stdioConn wraps stdin/stdout as a net.Conn-like ReadWriteCloser
type stdioConn struct {
	reader io.Reader
	writer io.Writer
}

func (rw *stdioConn) Read(p []byte) (int, error) {
	return rw.reader.Read(p)
}

func (rw *stdioConn) Write(p []byte) (int, error) {
	return rw.writer.Write(p)
}

func (rw *stdioConn) Close() error {
	// You generally don't close stdin/stdout, so just return nil
	return nil
}
