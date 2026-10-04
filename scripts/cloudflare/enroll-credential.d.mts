export interface EnrollmentInput { owner: string; operation: string; token: string; accountId?: string }
export class EnrollmentFailure extends Error { code: string; status?: number; constructor(code: string, status?: number) }
export function validateEnrollment(input: EnrollmentInput, native?: boolean): void;
export function enrollCloudflare(transport: {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}, input: EnrollmentInput): Promise<{ status: 'connected'; connection_id: string }>;
