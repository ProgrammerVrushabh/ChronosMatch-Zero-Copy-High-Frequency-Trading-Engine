"""Single-process prototype of a memory-mapped ring buffer.

Note: this starter implementation's counters are process-local, so it is not
yet a correct multi-process IPC implementation. See README.md.
"""
import mmap
import os
import struct
import threading

ORDER = struct.Struct("<QbqIq")
SLOT_SIZE = ORDER.size
CAPACITY = 65536
HEADER_SIZE = 8
FILE_SIZE = HEADER_SIZE + CAPACITY * SLOT_SIZE


class SharedBus:
    """Thread-safe single-producer/single-consumer mmap ring buffer prototype."""

    def __init__(self, path="chronos.bus", create=True):
        self.path = path
        self.capacity = CAPACITY
        self.write_seq = 0
        self.read_seq = 0
        self.lock = threading.Lock()
        if create:
            with open(path, "wb") as f:
                f.truncate(FILE_SIZE)
        self.file = open(path, "r+b")
        self.mm = mmap.mmap(self.file.fileno(), FILE_SIZE)
        self.closed = False

    def publish(self, order_id, side, price, qty, timestamp_ns):
        with self.lock:
            if self.write_seq - self.read_seq >= self.capacity:
                return False
            offset = HEADER_SIZE + (self.write_seq % self.capacity) * SLOT_SIZE
            ORDER.pack_into(self.mm, offset, order_id, side, price, qty, timestamp_ns)
            self.write_seq += 1
            return True

    def consume(self):
        with self.lock:
            if self.read_seq >= self.write_seq:
                return None
            offset = HEADER_SIZE + (self.read_seq % self.capacity) * SLOT_SIZE
            order = ORDER.unpack_from(self.mm, offset)
            self.read_seq += 1
            return order

    def close(self):
        if not self.closed:
            self.mm.close()
            self.file.close()
            self.closed = True
