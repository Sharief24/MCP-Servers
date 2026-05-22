import { z } from 'zod';

/**
 * LinkedIn API v2 returns localized-text fields as objects
 * e.g. { localized: { en_US: "..." }, preferredLocale: {...} }
 * and picture fields as { displayImage~: { elements: [...] } }.
 * This preprocessor coerces those to plain strings before Zod validation.
 */
function extractLinkedInString(val: unknown): unknown {
  if (typeof val === 'string' || val === undefined || val === null) return val;
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    // Localized text: { localized: { en_US: "..." } }
    if (obj['localized'] && typeof obj['localized'] === 'object') {
      const loc = obj['localized'] as Record<string, unknown>;
      const found = Object.values(loc).find(v => typeof v === 'string');
      if (found) return found;
    }
    // Profile picture: { displayImage~: { elements: [{ identifiers: [{ identifier: url }] }] } }
    const di = obj['displayImage~'] as Record<string, unknown> | undefined;
    if (di) {
      const els = di['elements'] as Array<Record<string, unknown>> | undefined;
      if (els && els.length > 0) {
        const ids = els[els.length - 1]['identifiers'] as Array<Record<string, unknown>> | undefined;
        if (ids && ids.length > 0) return (ids[0]['identifier'] as string) ?? '';
      }
    }
    // Fallback: stringify so Zod never sees a raw object
    return '';
  }
  return String(val);
}

// LinkedIn API types
export const LinkedInProfileSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  headline: z.preprocess(extractLinkedInString, z.string().optional()),
  profilePictureUrl: z.preprocess(extractLinkedInString, z.string().optional()),
  vanityName: z.string().optional(),
});

export type LinkedInProfile = z.infer<typeof LinkedInProfileSchema>;

export const LinkedInPostSchema = z.object({
  id: z.string(),
  author: z.string(),
  text: z.string(),
  createdAt: z.string(),
  likeCount: z.number().optional(),
  commentCount: z.number().optional(),
  shareCount: z.number().optional(),
});

export type LinkedInPost = z.infer<typeof LinkedInPostSchema>;

export const LinkedInConnectionSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  headline: z.preprocess(extractLinkedInString, z.string().optional()),
  connectedAt: z.string().optional(),
});

export type LinkedInConnection = z.infer<typeof LinkedInConnectionSchema>;

// Profile Edit types
export const LinkedInSkillSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
});

export type LinkedInSkill = z.infer<typeof LinkedInSkillSchema>;

export const LinkedInPositionSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  company: z.string(),
  description: z.string().optional(),
  startDate: z.object({
    year: z.number(),
    month: z.number().optional(),
  }),
  endDate: z.object({
    year: z.number(),
    month: z.number().optional(),
  }).optional(),
  current: z.boolean().optional(),
});

export type LinkedInPosition = z.infer<typeof LinkedInPositionSchema>;

export const LinkedInEducationSchema = z.object({
  id: z.string().optional(),
  schoolName: z.string(),
  degree: z.string().optional(),
  fieldOfStudy: z.string().optional(),
  startDate: z.object({
    year: z.number(),
    month: z.number().optional(),
  }).optional(),
  endDate: z.object({
    year: z.number(),
    month: z.number().optional(),
  }).optional(),
  grade: z.string().optional(),
  activities: z.string().optional(),
});

export type LinkedInEducation = z.infer<typeof LinkedInEducationSchema>;

export const LinkedInCertificationSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  authority: z.string(),
  licenseNumber: z.string().optional(),
  startDate: z.object({
    year: z.number(),
    month: z.number().optional(),
  }).optional(),
  endDate: z.object({
    year: z.number(),
    month: z.number().optional(),
  }).optional(),
  url: z.string().optional(),
});

export type LinkedInCertification = z.infer<typeof LinkedInCertificationSchema>;

export const LinkedInPublicationSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  publisher: z.string().optional(),
  date: z.object({
    year: z.number(),
    month: z.number().optional(),
    day: z.number().optional(),
  }).optional(),
  description: z.string().optional(),
  url: z.string().optional(),
});

export type LinkedInPublication = z.infer<typeof LinkedInPublicationSchema>;

export const LinkedInLanguageSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  proficiency: z.enum(['ELEMENTARY', 'LIMITED_WORKING', 'PROFESSIONAL_WORKING', 'FULL_PROFESSIONAL', 'NATIVE_OR_BILINGUAL']).optional(),
});

export type LinkedInLanguage = z.infer<typeof LinkedInLanguageSchema>;

// Configuration types
export interface ServerConfig {
  linkedInAccessToken?: string;
  linkedInClientId?: string;
  linkedInClientSecret?: string;
  linkedInRedirectUri?: string;
  port?: number;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

// MCP Tool types
export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

export interface ToolArguments {
  [key: string]: unknown;
}

