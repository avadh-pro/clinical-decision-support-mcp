import { Request } from "express";
import { FhirContext } from "./fhir-context";
import * as jose from "jose";
import { McpConstants } from "./mcp-constants";

// Fallback FHIR URL from platform settings (used when SHARP header is missing)
const FALLBACK_FHIR_URL = process.env["FALLBACK_FHIR_URL"] || "";

export const FhirUtilities = {
  getFhirContext: (req: Request): FhirContext | null => {
    const headers = req.headers;
    let url = headers[McpConstants.FhirServerUrlHeaderName]?.toString();

    // If no SHARP header, try fallback FHIR URL
    if (!url && FALLBACK_FHIR_URL) {
      console.log("No x-fhir-server-url header — using fallback FHIR URL");
      url = FALLBACK_FHIR_URL;
    }

    if (!url) {
      return null;
    }

    const token = headers[McpConstants.FhirAccessTokenHeaderName]?.toString();
    return { url, token };
  },
  getPatientIdIfContextExists: (req: Request) => {
    const fhirToken =
      req.headers[McpConstants.FhirAccessTokenHeaderName]?.toString();

    if (fhirToken) {
      const claims = jose.decodeJwt(fhirToken);
      if (claims["patient"]) {
        return claims["patient"]?.toString();
      }
    }

    return req.headers[McpConstants.PatientIdHeaderName]?.toString() || null;
  },
};
