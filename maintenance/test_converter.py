"""Synthetic format/safety tests, not a full FLUX generation test."""
import hashlib
import importlib.util
import tempfile
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file
from safetensors import safe_open

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('fill_converter', ROOT / 'tools/convert_fill_fp8.py')
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)


def expect_error(source, output, contains):
    try:
        converter.convert(source, output)
    except ValueError as error:
        assert contains in str(error), str(error)
    else:
        raise AssertionError('Expected rejection')


with tempfile.TemporaryDirectory(prefix='converter-test-', dir=ROOT / 'maintenance') as directory:
    folder = Path(directory)
    source, output = folder / 'source.safetensors', folder / 'output.safetensors'
    weights = {'img_in.weight': torch.ones(3072, 384), 'sample': torch.tensor([-500., -1., 0., 1., 500.])}
    save_file(weights, str(source), metadata={'author': 'synthetic-test', 'modelspec.hash_sha256': 'stale'})
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    converter.convert(source, output)
    actual = load_file(str(output))
    assert set(actual) == set(weights)
    for key, value in weights.items():
        assert actual[key].dtype == torch.float8_e4m3fn
        assert torch.equal(actual[key].float(), value.clamp(-448, 448).to(torch.float8_e4m3fn).float())
    with safe_open(str(output), framework='pt') as result:
        assert result.metadata()['author'] == 'synthetic-test'
        assert 'modelspec.hash_sha256' not in result.metadata()
    expect_error(source, output, 'Output already exists')
    expect_error(source, source, 'matches source')
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    wrong = folder / 'wrong.safetensors'
    save_file({'img_in.weight': torch.ones(2, 2)}, str(wrong))
    expect_error(wrong, folder / 'wrong-output.safetensors', 'Expected the single-file')
    invalid = folder / 'invalid.safetensors'
    save_file({'img_in.weight': weights['img_in.weight'], 'bad': torch.tensor([float('nan')])}, str(invalid))
    expect_error(invalid, folder / 'invalid-output.safetensors', 'Non-finite')
    assert not (folder / 'invalid-output.safetensors').exists()
    assert not list(folder.glob('*.partial'))
print('PASS: FP8 format/values/metadata, source preservation, no overwrite, architecture check, error cleanup')
