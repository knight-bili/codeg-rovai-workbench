"""记录已实际完成的CI步骤；构建、模拟器和真机状态分开。"""
import json
import os
from pathlib import Path
import sys

role, stage, status = sys.argv[1:4]
assert status in ('passed', 'failed')
directory = Path(os.environ['FOUNDATION_CI_EVIDENCE'])
directory.mkdir(parents=True, exist_ok=True)
result_file = directory / 'result.json'
result = json.loads(result_file.read_text(encoding='utf-8')) if result_file.exists() else {
    'role': role, 'workflowCommit': os.environ['GITHUB_SHA'], 'runnerOS': os.environ['RUNNER_OS'],
    'runnerArch': os.environ['RUNNER_ARCH'], 'realDeviceAcceptance': 'not_run',
    'integratedProductAcceptance': 'not_run', 'stages': {}
}
assert result['role'] == role
result['stages'][stage] = status
result_file.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
