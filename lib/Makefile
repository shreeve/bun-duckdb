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
#   make                       # builds untagged libduckdb-shim.{so,dylib}
#                              # (what local contributors get)
#
#   make TAGGED=1              # builds platform-tagged name like
#                              # libduckdb-shim-linux-x64.so — what CI
#                              # produces before bundling into the npm
#                              # tarball
#
#   make clean                 # removes built artifacts
#
# Override the install location with PREFIX:
#   make install PREFIX=/opt/local

UNAME_S := $(shell uname -s)
UNAME_M := $(shell uname -m)

# Map uname output to Bun's process.platform / process.arch values so the
# tagged filename matches what findShimLibrary() looks for at runtime.

ifeq ($(UNAME_S),Linux)
  PLATFORM       := linux
  EXT            := so
  CFLAGS_PIC     := -fPIC
  LDFLAGS_SHARED := -shared
  # Bake rpath entries so the shim can resolve libduckdb.so at the
  # standard install paths the driver's findDuckDBLibrary() also checks.
  LDFLAGS_RPATH  := -Wl,-rpath,/usr/local/lib -Wl,-rpath,/usr/lib
endif

ifeq ($(UNAME_S),Darwin)
  PLATFORM       := darwin
  EXT            := dylib
  CFLAGS_PIC     := -fPIC
  LDFLAGS_SHARED := -dynamiclib
  # CRITICAL: libduckdb.dylib (as shipped in libduckdb-osx-universal.zip)
  # has its install_name set to @rpath/libduckdb.dylib. Without LC_RPATH
  # entries on the shim, dlopen has nothing to substitute for @rpath and
  # the shim fails to load with "Library not loaded: @rpath/libduckdb.dylib"
  # at runtime. Bake both common Homebrew prefixes + /usr/lib so the shim
  # finds libduckdb wherever the user installed it.
  LDFLAGS_RPATH  := -Wl,-rpath,/opt/homebrew/lib -Wl,-rpath,/usr/local/lib -Wl,-rpath,/usr/lib
endif

# uname -m varies: x86_64 / amd64 → x64, aarch64 / arm64 → arm64
ARCH := $(strip $(if $(filter x86_64 amd64,$(UNAME_M)),x64,$(if $(filter aarch64 arm64,$(UNAME_M)),arm64,unknown)))

# `make TAGGED=1` → platform-tagged output (CI). Otherwise → untagged (dev).
ifeq ($(strip $(TAGGED)),1)
  SHIM := libduckdb-shim-$(PLATFORM)-$(ARCH).$(EXT)
else
  SHIM := libduckdb-shim.$(EXT)
endif

CC        ?= gcc
CFLAGS    ?= -O2 -Wall -Wextra
PREFIX    ?= /usr/local

# Auto-detect a Homebrew libduckdb on macOS so contributors don't have to
# set LIBDUCKDB manually. Homebrew on Apple Silicon installs into
# /opt/homebrew/{lib,include}; on Intel macOS into /usr/local/{lib,include}
# (which is already on the default search path).
ifeq ($(PLATFORM),darwin)
  ifneq ($(wildcard /opt/homebrew/lib/libduckdb.dylib),)
    LIBDUCKDB ?= -L/opt/homebrew/lib -lduckdb
    CFLAGS    += -I/opt/homebrew/include
  endif
endif

LIBDUCKDB ?= -lduckdb

all: $(SHIM)

$(SHIM): duckdb-shim.c
	$(CC) $(CFLAGS_PIC) $(CFLAGS) $(LDFLAGS_SHARED) $(LDFLAGS_RPATH) -o $@ $< $(LIBDUCKDB)

install: $(SHIM)
	install -d $(PREFIX)/lib
	install -m 0755 $(SHIM) $(PREFIX)/lib/

clean:
	rm -f libduckdb-shim.so libduckdb-shim.dylib \
	      libduckdb-shim-*.so libduckdb-shim-*.dylib *.o

print-platform:
	@echo "PLATFORM=$(PLATFORM) ARCH=$(ARCH) EXT=$(EXT) SHIM=$(SHIM)"

.PHONY: all install clean print-platform
