import { createRequire } from "node:module";
import { default as Ajv2020Class } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { AnyValidateFunction } from "ajv/dist/core.js";

const require = createRequire(import.meta.url);
const acpSchema = require("@agentclientprotocol/sdk/schema/schema.json");

interface AjvInstance {
  addFormat: (name: string, format: { type: string; validate: (n: number) => boolean }) => void;
  addSchema: (schema: unknown, key: string) => void;
  compile: (schema: unknown) => AnyValidateFunction;
  errors?: Array<{ instancePath?: string; message?: string }>;
}

const AjvConstructor =
  (Ajv2020Class as unknown as { default?: new (opts?: Record<string, unknown>) => AjvInstance })
    .default || (Ajv2020Class as unknown as new (opts?: Record<string, unknown>) => AjvInstance);
const ajv: AjvInstance = new AjvConstructor({ allErrors: true, strict: false });

const addFormatsFn =
  (addFormats as unknown as { default?: (instance: unknown) => void }).default ||
  (addFormats as unknown as (instance: unknown) => void);
addFormatsFn(ajv);

for (const fmt of ["uint8", "uint16", "uint32", "uint64", "int32", "int64"]) {
  ajv.addFormat(fmt, {
    type: "number",
    validate: (n: number) =>
      typeof n === "number" && Number.isInteger(n) && (fmt.startsWith("u") ? n >= 0 : true),
  });
}

ajv.addSchema(acpSchema, "acp.json");

const validatorCache = new Map<string, AnyValidateFunction>();

export function getAcpValidator(definition: string): AnyValidateFunction {
  let v = validatorCache.get(definition);
  if (!v) {
    const compiled = ajv.compile({ $ref: `acp.json#/$defs/${definition}` }) as AnyValidateFunction;
    validatorCache.set(definition, compiled);
    v = compiled;
  }
  return v;
}

export interface AcpValidationResult {
  valid: boolean;
  errors?: string[];
}

export function validateAcpSchema(definition: string, data: unknown): AcpValidationResult {
  const validator = getAcpValidator(definition);
  const valid = Boolean(validator(data));
  if (valid) {
    return { valid: true };
  }
  const errors = validator.errors?.map((e) => `${e.instancePath || "/"}: ${e.message}`) ?? [
    "Unknown schema error",
  ];
  return { valid: false, errors };
}

export function validateSessionNotification(data: unknown): AcpValidationResult {
  return validateAcpSchema("SessionNotification", data);
}

export function validateSessionUpdate(data: unknown): AcpValidationResult {
  return validateAcpSchema("SessionUpdate", data);
}

export function validateUsageUpdate(data: unknown): AcpValidationResult {
  return validateAcpSchema("UsageUpdate", data);
}

export function validatePlan(data: unknown): AcpValidationResult {
  return validateAcpSchema("Plan", data);
}

export function validateToolCallUpdate(data: unknown): AcpValidationResult {
  return validateAcpSchema("ToolCallUpdate", data);
}

export function validateAvailableCommandsUpdate(data: unknown): AcpValidationResult {
  return validateAcpSchema("AvailableCommandsUpdate", data);
}

export function validateInitializeRequest(data: unknown): AcpValidationResult {
  return validateAcpSchema("InitializeRequest", data);
}

export function validateInitializeResponse(data: unknown): AcpValidationResult {
  return validateAcpSchema("InitializeResponse", data);
}

export function validatePromptRequest(data: unknown): AcpValidationResult {
  return validateAcpSchema("PromptRequest", data);
}

export function validatePromptResponse(data: unknown): AcpValidationResult {
  return validateAcpSchema("PromptResponse", data);
}
