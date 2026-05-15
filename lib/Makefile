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

# ---------------------------------------------------------------------------
# Cross-compile darwin-x64 shim from a macOS host (typically Apple Silicon).
#
# GitHub's Intel macos-13 runner pool is small enough to queue jobs for
# hours, which historically held up our publish step. This target sidesteps
# that entirely by producing a native x86_64 shim from any macOS runner:
# downloads the official universal libduckdb release, extracts the x86_64
# slice with lipo, then compiles with clang -arch x86_64. Result is a
# bit-for-bit equivalent dylib to one built natively on Intel.
#
# Output: libduckdb-shim-darwin-x64.dylib (always platform-tagged).
#
# Usage: make darwin-x64-from-arm64                  (uses pinned DuckDB version)
#        make darwin-x64-from-arm64 DUCKDB_VERSION=v1.5.3
# ---------------------------------------------------------------------------

DUCKDB_VERSION ?= v1.5.2
SHIM_DARWIN_X64 := libduckdb-shim-darwin-x64.dylib

darwin-x64-from-arm64:
	@if [ "$(PLATFORM)" != "darwin" ]; then \
		echo "ERROR: darwin-x64-from-arm64 must run on macOS (host is $(PLATFORM))"; \
		exit 1; \
	fi
	@TMP=$$(mktemp -d) && trap "rm -rf $$TMP" EXIT && \
	  cd $$TMP && \
	  echo "→ downloading libduckdb $(DUCKDB_VERSION) universal" && \
	  curl -fsSL -o lib.zip \
	    "https://github.com/duckdb/duckdb/releases/download/$(DUCKDB_VERSION)/libduckdb-osx-universal.zip" && \
	  unzip -q lib.zip && \
	  echo "→ extracting x86_64 slice from universal libduckdb" && \
	  lipo libduckdb.dylib -extract x86_64 -output libduckdb-x64.dylib && \
	  mv libduckdb-x64.dylib libduckdb.dylib && \
	  cd "$(CURDIR)" && \
	  echo "→ cross-compiling shim ($(SHIM_DARWIN_X64))" && \
	  $(CC) -arch x86_64 $(CFLAGS_PIC) $(CFLAGS) -I$$TMP \
	    $(LDFLAGS_SHARED) $(LDFLAGS_RPATH) \
	    -o $(SHIM_DARWIN_X64) duckdb-shim.c -L$$TMP -lduckdb && \
	  echo "→ verify:" && \
	  file $(SHIM_DARWIN_X64) && \
	  otool -l $(SHIM_DARWIN_X64) | grep -A 1 LC_RPATH

install: $(SHIM)
	install -d $(PREFIX)/lib
	install -m 0755 $(SHIM) $(PREFIX)/lib/

clean:
	rm -f libduckdb-shim.so libduckdb-shim.dylib \
	      libduckdb-shim-*.so libduckdb-shim-*.dylib *.o

print-platform:
	@echo "PLATFORM=$(PLATFORM) ARCH=$(ARCH) EXT=$(EXT) SHIM=$(SHIM)"

.PHONY: all install clean print-platform darwin-x64-from-arm64
