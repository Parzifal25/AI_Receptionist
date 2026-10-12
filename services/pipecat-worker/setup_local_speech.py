"""Provision the local (credential-free) speech models — HALO Phase B.

Downloads the pinned models, verifies every file against a SHA-256, converts
the Piper voices so sherpa-onnx can load them, and writes `manifest.json`.
Both the Pipecat worker (local_speech.py) and the gateway's TypeScript
providers read that manifest; nothing else decides which model is used.

    .venv/bin/python services/pipecat-worker/setup_local_speech.py models/voice-local
    # then: VOICE_LOCAL_MODEL_DIR=$PWD/models/voice-local

About 0.55 GB on disk. Idempotent: verified files are not downloaded again.
Models and licences are listed in docs/LOCAL_SPEECH.md.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tarfile
import tempfile
import urllib.request

SHERPA_RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
PIPER_VOICES = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

STT_ARCHIVE = "sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05"
STT_FILES = {
    "model.int8.onnx": "e3042b2f3b3ef0af2211bf99d2b4bf94a21f5ac0e9898827e7dd6d003a860e91",
    "tokens.txt": "7d99997ef207ff14c2cfe825f2aa037528ea250113cc3c6392bfe49326884ba6",
}

# language -> (voice id, path under piper-voices, sha256 of .onnx, sha256 of .onnx.json)
PIPER = {
    "te": (
        "te_IN-venkatesh-medium",
        "te/te_IN/venkatesh/medium",
        "dfaa5b7833cd48d946f3fe18c9c934aaa4e8590aac6922fddf34783a694c3c87",
        "59bad556763d1f24b3434201d7bdee275bb1a70db3e1c65d38e6c3d39b224343",
    ),
    "en": (
        "en_US-joe-medium",
        "en/en_US/joe/medium",
        "58afce0321b8d9c46d7cdf9c16500cc55a793b4220212dba6b70fb788b3baf06",
        "3d6d5410b3795cb1950595247ef8f06190719e6fdbfa3a2356d8ec368e1aad33",
    ),
}


def sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verified(path: str, expected: str) -> bool:
    return os.path.isfile(path) and sha256(path) == expected


def download(url: str, path: str) -> None:
    print(f"  downloading {url}")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    partial = path + ".part"
    with urllib.request.urlopen(url, timeout=60) as response, open(partial, "wb") as out:
        shutil.copyfileobj(response, out, 1 << 20)
    os.replace(partial, path)


def fetch(url: str, path: str, expected: str) -> None:
    if verified(path, expected):
        return
    download(url, path)
    if not verified(path, expected):
        os.remove(path)
        raise SystemExit(f"checksum mismatch for {url}; refusing to use it")


def provision_stt(root: str) -> dict:
    target = os.path.join(root, "stt")
    if not all(verified(os.path.join(target, name), digest) for name, digest in STT_FILES.items()):
        os.makedirs(target, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=root) as scratch:
            archive = os.path.join(scratch, "stt.tar.bz2")
            download(f"{SHERPA_RELEASES}/asr-models/{STT_ARCHIVE}.tar.bz2", archive)
            with tarfile.open(archive, "r:bz2") as tar:
                for name in STT_FILES:
                    member = tar.extractfile(f"{STT_ARCHIVE}/{name}")
                    if member is None:
                        raise SystemExit(f"{name} missing from the STT archive")
                    with open(os.path.join(target, name), "wb") as out:
                        shutil.copyfileobj(member, out, 1 << 20)
        for name, digest in STT_FILES.items():
            if not verified(os.path.join(target, name), digest):
                raise SystemExit(f"checksum mismatch for stt/{name}; refusing to use it")
    return {
        "engine": "sherpa-onnx",
        "type": "omnilingual-ctc",
        "id": STT_ARCHIVE,
        "model": "stt/model.int8.onnx",
        "tokens": "stt/tokens.txt",
        "sampleRate": 16000,
        "languages": ["te-IN", "en-IN"],
    }


def provision_espeak(root: str) -> str:
    target = os.path.join(root, "tts", "espeak-ng-data")
    if not os.path.isfile(os.path.join(target, "te_dict")):
        with tempfile.TemporaryDirectory(dir=root) as scratch:
            archive = os.path.join(scratch, "espeak.tar.bz2")
            download(f"{SHERPA_RELEASES}/tts-models/espeak-ng-data.tar.bz2", archive)
            with tarfile.open(archive, "r:bz2") as tar:
                members = [m for m in tar.getmembers() if m.name.startswith("espeak-ng-data/") and ".." not in m.name]
                tar.extractall(os.path.join(root, "tts"), members=members)
    for required in ("te_dict", "en_dict", "phontab"):
        if not os.path.isfile(os.path.join(target, required)):
            raise SystemExit(f"espeak-ng-data is incomplete: {required} missing")
    return "tts/espeak-ng-data"


def provision_voice(root: str, language: str) -> dict:
    """Piper ships plain VITS weights; sherpa-onnx needs its metadata and a token table."""
    import onnx

    voice_id, remote, model_sha, config_sha = PIPER[language]
    sources = os.path.join(root, ".downloads")
    model_src = os.path.join(sources, f"{voice_id}.onnx")
    config_src = os.path.join(sources, f"{voice_id}.onnx.json")
    fetch(f"{PIPER_VOICES}/{remote}/{voice_id}.onnx", model_src, model_sha)
    fetch(f"{PIPER_VOICES}/{remote}/{voice_id}.onnx.json", config_src, config_sha)

    target = os.path.join(root, "tts", language)
    os.makedirs(target, exist_ok=True)
    with open(config_src, encoding="utf-8") as handle:
        config = json.load(handle)
    with open(os.path.join(target, "tokens.txt"), "w", encoding="utf-8") as tokens:
        for symbol, ids in config["phoneme_id_map"].items():
            tokens.write(f"{symbol} {ids[0]}\n")
    model = onnx.load(model_src)
    del model.metadata_props[:]
    for key, value in {
        "model_type": "vits",
        "comment": "piper",
        "language": config["language"]["name_english"],
        "voice": config["espeak"]["voice"],
        "has_espeak": 1,
        "n_speakers": config["num_speakers"],
        "sample_rate": config["audio"]["sample_rate"],
    }.items():
        entry = model.metadata_props.add()
        entry.key, entry.value = key, str(value)
    onnx.save(model, os.path.join(target, "model.onnx"))
    return {
        "id": voice_id,
        "model": f"tts/{language}/model.onnx",
        "tokens": f"tts/{language}/tokens.txt",
        "sampleRate": int(config["audio"]["sample_rate"]),
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    root = os.path.abspath(sys.argv[1])
    os.makedirs(root, exist_ok=True)
    print(f"provisioning local speech models in {root}")
    stt = provision_stt(root)
    data_dir = provision_espeak(root)
    voices = {language: provision_voice(root, language) for language in PIPER}
    manifest = {
        "version": 1,
        "stt": stt,
        "tts": {"engine": "sherpa-onnx", "type": "vits-piper", "dataDir": data_dir, "voices": voices},
    }
    with open(os.path.join(root, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")
    print(f"done. Set VOICE_LOCAL_MODEL_DIR={root}")


if __name__ == "__main__":
    main()
