import test from 'node:test';
import assert from 'node:assert/strict';
import { getDatabaseConnectionOptions } from './databaseConfig.js';

const DATABASE_URL = 'postgresql://postgres.example:secret@pooler.example.com:6543/postgres?sslmode=require&application_name=hollow';

test('PostgreSQL TLS verification is enabled by default and URL overrides are removed', () => {
  const config = getDatabaseConnectionOptions({ DATABASE_URL });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(new URL(config.connectionString).searchParams.has('sslmode'), false);
  assert.equal(new URL(config.connectionString).searchParams.get('application_name'), 'hollow');
});

test('a configured provider CA is passed with certificate verification enabled', () => {
  const ca = '-----BEGIN CERTIFICATE-----\\nTEST\\n-----END CERTIFICATE-----';
  const config = getDatabaseConnectionOptions({ DATABASE_URL, DATABASE_SSL_CA: ca });
  assert.equal(config.ssl.ca, '-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----');
  assert.equal(config.ssl.rejectUnauthorized, true);
});

test('local development can explicitly disable PostgreSQL TLS', () => {
  const config = getDatabaseConnectionOptions({ DATABASE_URL, DATABASE_SSL: 'disable' });
  assert.equal(config.ssl, false);
});

test('missing DATABASE_URL does not request TLS', () => {
  assert.deepEqual(getDatabaseConnectionOptions({}), { connectionString: undefined, ssl: false });
});
