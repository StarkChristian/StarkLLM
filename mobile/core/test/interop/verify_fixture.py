"""Replays test/interop/fixture.json with the independent Python Noise library `noiseprotocol`.

The JS side (salty-crypto + our framing) and this implementation must produce and accept exactly
the same bytes for both StarkLLM handshakes (IKpsk2 for pairing, IK for sessions), the padded
transport messages and the rekey schedule.

Run:  pip install noiseprotocol==0.3.1 && python test/interop/verify_fixture.py
"""
import json
import pathlib
import sys

from noise.connection import Keypair, NoiseConnection

PAD = 256
REKEY_INTERVAL = 1000


def pad(msg: bytes) -> bytes:
    total = -(-(len(msg) + 2) // PAD) * PAD
    return bytes([len(msg) >> 8, len(msg) & 255]) + msg + bytes(total - len(msg) - 2)


def unpad(p: bytes) -> bytes:
    assert len(p) % PAD == 0 and len(p) >= PAD
    n = (p[0] << 8) | p[1]
    assert p[2 + n:] == bytes(len(p) - 2 - n), "padding must be zero"
    return p[2:2 + n]


def conn(case, initiator):
    c = NoiseConnection.from_name(case["protocol_name"].encode())
    (c.set_as_initiator if initiator else c.set_as_responder)()
    c.set_prologue(bytes.fromhex(case["prologue_hex"]))
    if case["psk_hex"]:
        c.set_psks(bytes.fromhex(case["psk_hex"]))
    side = "initiator" if initiator else "responder"
    c.set_keypair_from_private_bytes(Keypair.STATIC, bytes.fromhex(case[f"{side}_static_secret"]))
    c.set_keypair_from_private_bytes(Keypair.EPHEMERAL, bytes.fromhex(case[f"{side}_ephemeral_secret"]))
    if initiator:
        other = NoiseConnection.from_name(case["protocol_name"].encode())
        other.set_as_responder()
        other.set_keypair_from_private_bytes(Keypair.STATIC, bytes.fromhex(case["responder_static_secret"]))
        c.set_keypair_from_public_bytes(Keypair.REMOTE_STATIC, other.noise_protocol.keypairs["s"].public_bytes)
    c.start_handshake()
    return c


def main():
    fixture = json.loads((pathlib.Path(__file__).parent / "fixture.json").read_text())
    for case in fixture["cases"]:
        name = case["protocol_name"]
        # 1. Python as initiator must produce the exact first message JS produced ...
        pi = conn(case, True)
        m1 = pi.write_message(bytes.fromhex(case["message1_payload_hex"]))
        assert bytes(m1).hex() == case["message1_hex"], f"{name}: message 1 differs"
        # 2. ... and as responder must accept it and produce the exact second message.
        pr = conn(case, False)
        payload = pr.read_message(bytes.fromhex(case["message1_hex"]))
        assert bytes(payload).hex() == case["message1_payload_hex"], f"{name}: payload 1"
        m2 = pr.write_message(bytes.fromhex(case["message2_payload_hex"]))
        assert bytes(m2).hex() == case["message2_hex"], f"{name}: message 2 differs"
        assert bytes(pi.read_message(m2)).hex() == case["message2_payload_hex"]
        assert pi.get_handshake_hash().hex() == case["handshake_hash_hex"], f"{name}: handshake hash"
        assert pr.get_handshake_hash().hex() == case["handshake_hash_hex"]
        assert pi.handshake_finished and pr.handshake_finished

        # 3. padded transport messages, both directions, byte for byte
        for t in case["transport"]:
            sender, receiver = (pi, pr) if t["from"] == "initiator" else (pr, pi)
            plain = bytes.fromhex(t["plaintext_hex"])
            ct = sender.encrypt(pad(plain))
            assert bytes(ct).hex() == t["ciphertext_hex"], f"{name}: transport message differs"
            assert unpad(receiver.decrypt(ct)) == plain

        # 4. rekey schedule: both sides rekey every 1000 messages per direction
        sent = len([t for t in case["transport"] if t["from"] == "initiator"])
        last = None
        for i in range(case["rekey_check"]["messages_after_transport"]):
            ct = pi.encrypt(pad(bytes([i & 255])))
            assert unpad(pr.decrypt(ct)) == bytes([i & 255])
            sent += 1
            if sent % REKEY_INTERVAL == 0:
                pi.rekey_outbound_cipher()
                pr.rekey_inbound_cipher()
            last = ct
        assert bytes(last).hex() == case["rekey_check"]["last_ciphertext_hex"], f"{name}: rekey schedule differs"
        print(f"ok  {name}")
    print("interop fixture verified with noiseprotocol")


if __name__ == "__main__":
    sys.exit(main())
