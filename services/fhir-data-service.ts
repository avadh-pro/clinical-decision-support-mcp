import { Request } from "express";
import { FhirClientInstance } from "../fhir-client";
import { FhirUtilities } from "../fhir-utilities";
import { NullUtilities } from "../null-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";

class FhirDataService {
  // Get patient ID from context or throw
  getPatientId(req: Request, providedId?: string): string {
    if (providedId) return providedId;
    return NullUtilities.getOrThrow(
      FhirUtilities.getPatientIdIfContextExists(req),
      "No patient ID provided and no patient context available",
    );
  }

  // Fetch patient demographics
  async getPatient(
    req: Request,
    patientId: string,
  ): Promise<fhirR4.Patient | null> {
    return FhirClientInstance.read<fhirR4.Patient>(
      req,
      `Patient/${patientId}`,
    );
  }

  // Search with error handling - returns empty array on failure instead of throwing
  async safeSearch(
    req: Request,
    resourceType: string,
    params: string[],
  ): Promise<fhirR4.BundleEntry[]> {
    try {
      const bundle = await FhirClientInstance.search(
        req,
        resourceType,
        params,
      );
      return bundle?.entry?.filter((e) => !!e.resource) ?? [];
    } catch (error) {
      console.error(
        `FHIR search failed for ${resourceType}:`,
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }

  // Parallel fetch multiple resource types
  async fetchParallel(
    req: Request,
    queries: Array<{ resourceType: string; params: string[] }>,
  ): Promise<Map<string, fhirR4.BundleEntry[]>> {
    const results = await Promise.allSettled(
      queries.map((q) => this.safeSearch(req, q.resourceType, q.params)),
    );
    const map = new Map<string, fhirR4.BundleEntry[]>();
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i]!;
      const result = results[i]!;
      map.set(
        query.resourceType,
        result.status === "fulfilled" ? result.value : [],
      );
    }
    return map;
  }

  // Extract age from patient
  getPatientAge(patient: fhirR4.Patient): number | null {
    if (!patient.birthDate) return null;
    const birth = new Date(patient.birthDate);
    const now = new Date();
    let age = now.getFullYear() - birth.getFullYear();
    const monthDiff = now.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate()))
      age--;
    return age;
  }

  // Extract patient sex
  getPatientSex(patient: fhirR4.Patient): string {
    return patient.gender || "unknown";
  }
}

export const FhirDataServiceInstance = new FhirDataService();
