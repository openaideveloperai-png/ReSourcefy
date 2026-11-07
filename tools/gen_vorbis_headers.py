# Generates the FSB5 Vorbis setup-header table used by ReSourcefy.
# FSB5 strips Vorbis setup headers and stores only a CRC32; python-fsb5's
# lookup maps that CRC to (quality, channels, rate). We regenerate each
# setup header with libvorbis once, offline, and ship the result.
import ctypes, ctypes.util, struct, sys, zlib, re
vorbis = ctypes.CDLL('libvorbis.so.0')
vorbisenc = ctypes.CDLL('libvorbisenc.so.2')

class OggPacket(ctypes.Structure):
    _fields_ = [('packet', ctypes.c_void_p), ('bytes', ctypes.c_long), ('b_o_s', ctypes.c_long),
                ('e_o_s', ctypes.c_long), ('granulepos', ctypes.c_longlong), ('packetno', ctypes.c_longlong)]

def buf(n): return ctypes.create_string_buffer(n)

src = open(sys.argv[1]).read()
lookup = {int(k): (int(q), int(c), int(r)) for k, q, c, r in re.findall(r'(\d+):\s*\((\d+),\s*(\d+),\s*(\d+)\)', src)}
out = [b'RSVH', struct.pack('<I', len(lookup))]
for crc, (quality, channels, rate) in sorted(lookup.items()):
    q = -0.1 + (1.0 - -0.1) * ((quality - 1) / (100 - 1))
    vi = buf(4096); vc = buf(1024); vd = buf(65536)
    vorbis.vorbis_info_init(vi)
    vorbis.vorbis_comment_init(vc)
    assert vorbisenc.vorbis_encode_setup_vbr(vi, ctypes.c_long(channels), ctypes.c_long(rate), ctypes.c_float(q)) == 0
    one = ctypes.c_int(1)
    vorbisenc.vorbis_encode_ctl(vi, 0x41, ctypes.byref(one))
    assert vorbisenc.vorbis_encode_setup_init(vi) == 0
    assert vorbis.vorbis_analysis_init(vd, vi) == 0
    pid, pcom, pset = OggPacket(), OggPacket(), OggPacket()
    assert vorbis.vorbis_analysis_headerout(vd, vc, ctypes.byref(pid), ctypes.byref(pcom), ctypes.byref(pset)) == 0
    setup = ctypes.string_at(pset.packet, pset.bytes)
    idh = ctypes.string_at(pid.packet, pid.bytes)
    comh = ctypes.string_at(pcom.packet, pcom.bytes)
    bs0 = vorbis.vorbis_info_blocksize(vi, 0); bs1 = vorbis.vorbis_info_blocksize(vi, 1)
    # mode block flags via a synthesis-side info
    vi2 = buf(4096); vc2 = buf(1024)
    vorbis.vorbis_info_init(vi2); vorbis.vorbis_comment_init(vc2)
    for data, bos, no in ((idh, 1, 0), (comh, 0, 1), (setup, 0, 2)):
        b = ctypes.create_string_buffer(data, len(data))
        p = OggPacket(ctypes.cast(b, ctypes.c_void_p), len(data), bos, 0, 0, no)
        assert vorbis.vorbis_synthesis_headerin(vi2, vc2, ctypes.byref(p)) == 0
    flags = []
    for m in range(64):
        pb = ctypes.create_string_buffer(bytes([(m << 1) & 0xff, (m >> 7) & 0xff, 0, 0]), 4)
        p = OggPacket(ctypes.cast(pb, ctypes.c_void_p), 4, 0, 0, 0, 3)
        bs = vorbis.vorbis_packet_blocksize(vi2, ctypes.byref(p))
        if bs <= 0: break
        flags.append(1 if bs == bs1 else 0)
    vorbis.vorbis_dsp_clear(vd)
    # sanity: CRC32 of the setup header should match the lookup key
    ok = (zlib.crc32(setup) & 0xffffffff) == crc
    if not ok: print('warning: crc mismatch for', crc, quality, channels, rate)
    out.append(struct.pack('<IBIHHB', crc, channels, rate, bs0, bs1, len(flags)) + bytes(flags) + struct.pack('<I', len(setup)) + setup)
data = b''.join(out)
open(sys.argv[2], 'wb').write(data)
print('entries', len(lookup), 'bytes', len(data))
