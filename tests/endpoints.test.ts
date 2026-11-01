import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CLOUD_PATH,
  DIAGNOSTICS_REPORT_PATH,
  endpointConfigProblem,
  endpointsFromBase,
  resolveEndpoints,
} from '../src/application/endpoints.ts';

interface EndpointConfig {
  version: number;
  environments: Record<string, { serverBaseUrl: string }>;
}

test('endpoint config keeps web same-origin and production on HTTPS', () => {
  const config = JSON.parse(
    readFileSync(new URL('../config/endpoints.json', import.meta.url), 'utf8'),
  ) as EndpointConfig;
  assert.equal(config.version, 1);
  assert.equal(config.environments.web!.serverBaseUrl, '');
  for (const [name, environment] of Object.entries(config.environments)) {
    assert.equal(endpointConfigProblem(environment.serverBaseUrl), undefined, name);
  }
  assert.deepEqual(endpointsFromBase(config.environments.androidDebug!.serverBaseUrl), {
    version: 1,
    cloudBase: `http://127.0.0.1:4003${CLOUD_PATH}`,
    diagnosticsReport: `http://127.0.0.1:4003${DIAGNOSTICS_REPORT_PATH}`,
  });
  assert.deepEqual(endpointsFromBase(config.environments.androidRelease!.serverBaseUrl), {
    version: 1,
    cloudBase: `https://catgo.online:4002${CLOUD_PATH}`,
    diagnosticsReport: `https://catgo.online:4002${DIAGNOSTICS_REPORT_PATH}`,
  });
});

test('runtime endpoints require version 1 and keep each valid field independently', () => {
  const injected = {
    version: 1,
    cloudBase: `https://cloud.example${CLOUD_PATH}`,
    diagnosticsReport: `https://cloud.example${DIAGNOSTICS_REPORT_PATH}`,
  };
  assert.deepEqual(resolveEndpoints({ __inoitaEndpoints: injected }), injected);
  assert.deepEqual(resolveEndpoints({}), { version: 1, cloudBase: '', diagnosticsReport: '' });
  assert.deepEqual(resolveEndpoints({ __inoitaEndpoints: { ...injected, version: 2 } }),
    { version: 1, cloudBase: '', diagnosticsReport: '' });

  const insecureCloud = resolveEndpoints({
    __inoitaEndpoints: { ...injected, cloudBase: 'http://cloud.example/__cloud' },
  });
  assert.equal(insecureCloud.cloudBase, '');
  assert.equal(insecureCloud.diagnosticsReport, injected.diagnosticsReport, '一个字段非法不连坐另一个');

  const missingPath = resolveEndpoints({
    __inoitaEndpoints: { ...injected, cloudBase: 'https://cloud.example' },
  });
  assert.equal(missingPath.cloudBase, '');

  const local = {
    version: 1,
    cloudBase: `http://127.0.0.1:4003${CLOUD_PATH}`,
    diagnosticsReport: `http://127.0.0.1:4003${DIAGNOSTICS_REPORT_PATH}`,
  };
  assert.deepEqual(resolveEndpoints({ __inoitaEndpoints: local }), local);
});

test('endpoint config rejects insecure or malformed bases', () => {
  assert.equal(endpointConfigProblem(''), undefined);
  assert.equal(endpointConfigProblem('https://catgo.online:4002'), undefined);
  assert.equal(endpointConfigProblem('http://127.0.0.1:4003'), undefined);
  assert.match(endpointConfigProblem('http://cloud.example') ?? '', /HTTPS/);
  assert.match(endpointConfigProblem('javascript:alert(1)') ?? '', /HTTPS/);
  assert.match(endpointConfigProblem('https://user:pass@cloud.example') ?? '', /账号/);
});
