import { z } from 'zod'
import { PROJECT_STATUSES, PROJECT_TYPES } from './constants'

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null))

// Only plain web links may be stored, so a record can never launch javascript:, file: or shell protocols.
export const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'Must be a valid http(s) URL')

const optionalUrl = z
  .union([httpUrl, z.literal('')])
  .optional()
  .transform((v) => (v ? v : null))

const tagList = z.array(z.string().trim().min(1).max(50)).max(30).default([])

export const projectInputSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required').max(150),
  description: z.string().trim().max(2000).default(''),
  type: z.enum(PROJECT_TYPES).nullable().optional().transform((v) => v ?? null),
  status: z.enum(PROJECT_STATUSES).default('active'),
  websiteUrl: optionalUrl,
  adminUrl: optionalUrl,
  hostingName: optionalText(150),
  domainProvider: optionalText(150),
  repositoryUrl: optionalUrl,
  developerName: optionalText(100),
  techStack: tagList,
  tags: tagList
})

export const projectListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  includeArchived: z.boolean().optional()
})

export type ProjectInput = z.input<typeof projectInputSchema>
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>
