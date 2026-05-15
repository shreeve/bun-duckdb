# Builds libduckdb-shim — a tiny C wrapper around three DuckDB C functions
# that take `duckdb_result` by value (the modern chunk-fetching API).
#
# Bun's FFI layer cannot pass structs by value on Linux x86_64 (SysV AMD64
# classifies the 48-byte struct as MEMORY → caller must put it on the
# stack, which Bun has no mechanism for). The shim sidesteps this by
# accepting a pointer and dereferencing on the C side.
#
# On macOS arm64 large structs go through a hidden pointer in r8 anyway,
# so the same `ptr(buf)` trick "happens" to work without the shim — but
# building and shipping the shim everywhere is simpler than per-platform
# conditional code paths in JS.
#
# Usage:
#   make            # builds libduckdb-shim for the current platform
#   make clean      # removes built artifacts
#
# Output goes next to libduckdb (so the runtime finds it via the same
# search paths). Override the install location with PREFIX:
#   make install PREFIX=/opt/local

UNAME_S := $(shell uname -s)

ifeq ($(UNAME_S),Linux)
  SHIM := libduckdb-shim.so
  CFLAGS_PIC := -fPIC
  LDFLAGS_SHARED := -shared
endif

ifeq ($(UNAME_S),Darwin)
  SHIM := libduckdb-shim.dylib
  CFLAGS_PIC := -fPIC
  LDFLAGS_SHARED := -dynamiclib
endif

CC ?= gcc
CFLAGS ?= -O2 -Wall -Wextra
LIBDUCKDB ?= -lduckdb

PREFIX ?= /usr/local

all: $(SHIM)

$(SHIM): duckdb-shim.c
	$(CC) $(CFLAGS_PIC) $(CFLAGS) $(LDFLAGS_SHARED) -o $@ $< $(LIBDUCKDB)

install: $(SHIM)
	install -d $(PREFIX)/lib
	install -m 0755 $(SHIM) $(PREFIX)/lib/

clean:
	rm -f libduckdb-shim.so libduckdb-shim.dylib *.o

.PHONY: all install clean
