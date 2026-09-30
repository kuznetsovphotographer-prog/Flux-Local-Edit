"""Prepare an unscaled FP8 FLUX.1 Fill checkpoint for this plugin.

Run using ComfyUI's Python (torch + safetensors). The source is never changed.
Writes tensors sequentially, not a full second model in RAM. No network access.
"""
import argparse
import json
import math
import os
import struct
import tempfile
from pathlib import Path

import torch
from safetensors import safe_open


def convert(source, destination, check_architecture=True):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination or destination.exists():
        raise ValueError('Output already exists, or matches source. Choose a new output path.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with safe_open(str(source), framework='pt', device='cpu') as weights:
        keys = sorted(weights.keys())
        if check_architecture:
            if 'img_in.weight' not in keys or weights.get_slice('img_in.weight').get_shape() != [3072, 384]:
                raise ValueError('Expected the single-file FLUX.1 Fill model, not dev/Klein/GGUF/diffusers shards.')
        header, offset = {}, 0
        for key in keys:
            shape = weights.get_slice(key).get_shape()
            length = math.prod(shape)
            header[key] = {'dtype': 'F8_E4M3', 'shape': shape, 'data_offsets': [offset, offset + length]}
            offset += length
        metadata = dict(weights.metadata() or {})
        metadata.pop('modelspec.hash_sha256', None)
        metadata['flux_local_edit.conversion'] = 'unscaled float8_e4m3fn; source preserved'
        header['__metadata__'] = metadata
        raw_header = json.dumps(header, separators=(',', ':')).encode('utf-8')
        raw_header += b' ' * ((-len(raw_header)) % 8)
        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(dir=destination.parent, prefix='fill-convert-', suffix='.partial', delete=False) as out:
                tmp_path = Path(out.name)
                out.write(struct.pack('<Q', len(raw_header)))
                out.write(raw_header)
                for index, key in enumerate(keys):
                    tensor = weights.get_tensor(key)
                    if not tensor.is_floating_point():
                        raise ValueError(f'Unexpected non-floating tensor: {key}')
                    tensor = tensor.float()
                    if not bool(torch.isfinite(tensor).all()):
                        raise ValueError(f'Non-finite source weights: {key}')
                    converted = tensor.clamp(-448, 448).to(torch.float8_e4m3fn).contiguous()
                    out.write(converted.view(torch.uint8).numpy().tobytes())
                    del tensor, converted
                    if index % 50 == 0:
                        print(f'{index + 1}/{len(keys)} tensors', flush=True)
                out.flush()
                os.fsync(out.fileno())
            with safe_open(str(tmp_path), framework='pt', device='cpu') as result:
                if sorted(result.keys()) != keys:
                    raise ValueError('Output key validation failed.')
                for key in keys:
                    if result.get_slice(key).get_shape() != header[key]['shape']:
                        raise ValueError(f'Output shape mismatch: {key}')
                if result.get_tensor(keys[0]).dtype != torch.float8_e4m3fn:
                    raise ValueError('Output dtype validation failed.')
            # link is no-clobber: protects an output created by another process.
            os.link(tmp_path, destination)
            print(f'Saved: {destination}', flush=True)
        finally:
            if tmp_path is not None and tmp_path.exists():
                tmp_path.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    convert(args.source, args.destination)
