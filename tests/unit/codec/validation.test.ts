import { describe, it, expect } from 'vitest';
import { ConfigCodec, type ConfigJsonSchema } from '../../../src/core/codec/index';

describe('duplicate value validation', () => {
  it('rejects an enum whose values collide after String() conversion (e.g. 1 and "1")', () => {
    const schema: ConfigJsonSchema = {
      type: 'object',
      properties: { field1: { enum: [1, '1'] } },
    };
    expect(() => new ConfigCodec(schema)).toThrow(/duplicate/);
  });

  it('rejects an enum with an exact duplicate value', () => {
    const schema: ConfigJsonSchema = {
      type: 'object',
      properties: { field1: { enum: [1, 1] } },
    };
    expect(() => new ConfigCodec(schema)).toThrow(/duplicate/);
  });

  it('rejects a conditional case list whose values collide after String() conversion', () => {
    const schema: ConfigJsonSchema = {
      type: 'object',
      properties: {
        fieldA: { enum: ['x1'] },
        fieldB: { dependsOn: 'fieldA', cases: { x1: [1, '1'] } },
      },
    };
    expect(() => new ConfigCodec(schema)).toThrow(/duplicate/);
  });

  it('rejects a conditional default list with duplicate values', () => {
    const schema: ConfigJsonSchema = {
      type: 'object',
      properties: {
        fieldA: { enum: ['x1'] },
        fieldB: { dependsOn: 'fieldA', cases: { x1: ['p'] }, default: [2, 2] },
      },
    };
    expect(() => new ConfigCodec(schema)).toThrow(/duplicate/);
  });
});
