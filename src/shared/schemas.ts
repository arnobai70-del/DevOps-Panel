import { z } from 'zod'
import { DOCUMENT_CATEGORIES, PROJECT_STATUSES, PROJECT_TYPES, STANDARD_SECRET_FIELDS } from './constants'

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
  tags: tagList,
  /** Extra details the user adds per project, shown in the order given. Not for secrets. */
  customFields: z
    .array(
      z.object({
        label: z.string().trim().min(1, 'Field name is required').max(100),
        value: z.string().trim().max(2000).default('')
      })
    )
    .max(50)
    .default([])
})

export const projectListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  includeArchived: z.boolean().optional()
})

export type ProjectInput = z.input<typeof projectInputSchema>
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>

const id = z.string().uuid()
const revision = z.number().int().positive()

export const projectUpdateSchema = z.object({ id, revision, input: projectInputSchema })

// undefined = keep the stored value, null or '' = clear it, any other string = replace it.
const secretValue = z.string().max(10_000).nullable().optional()

export const credentialSaveSchema = z.object({
  id: id.optional(),
  revision: revision.optional(),
  projectId: id,
  serviceName: z.string().trim().min(1, 'Service name is required').max(150),
  serviceUrl: optionalUrl,
  notes: z.string().trim().max(2000).default(''),
  username: secretValue,
  password: secretValue,
  apiKey: secretValue,
  apiSecret: secretValue,
  /** When given, replaces the extra fields. An entry with an id and no value keeps that field's stored value. */
  extras: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        label: z.string().trim().min(1, 'Field label is required').max(100),
        value: z.string().max(10_000).optional()
      })
    )
    .max(30)
    .optional()
})

export const credentialFieldSchema = z.union([
  z.enum(STANDARD_SECRET_FIELDS),
  z.string().regex(/^extra:[0-9a-f-]{36}$/)
])

export const documentMetadataSchema = z.object({
  displayName: z.string().trim().min(1, 'Document name is required').max(200),
  purpose: z.string().trim().min(1, 'Purpose is required').max(500),
  description: z.string().trim().max(5000).default(''),
  category: z.enum(DOCUMENT_CATEGORIES).nullable().optional().transform((v) => v ?? null),
  tags: tagList
})

export const documentCreateSchema = z.object({
  projectId: id,
  fileToken: z.string().uuid(),
  metadata: documentMetadataSchema
})

export const documentUpdateSchema = z.object({
  id,
  revision,
  metadata: documentMetadataSchema,
  /** Optional replacement file picked with documents.pickFile(); bumps the document version. */
  fileToken: z.string().uuid().optional()
})

export const noteSaveSchema = z.object({
  id: id.optional(),
  revision: revision.optional(),
  projectId: id,
  title: z.string().trim().min(1, 'Title is required').max(200),
  body: z.string().max(100_000).default('')
})

export const linkSaveSchema = z.object({
  id: id.optional(),
  revision: revision.optional(),
  projectId: id,
  label: z.string().trim().min(1, 'Label is required').max(150),
  url: httpUrl,
  purpose: optionalText(500)
})

export type ProjectUpdate = z.input<typeof projectUpdateSchema>
export type CredentialSave = z.input<typeof credentialSaveSchema>
export type CredentialField = z.infer<typeof credentialFieldSchema>
export type DocumentMetadata = z.input<typeof documentMetadataSchema>
export type DocumentCreate = z.input<typeof documentCreateSchema>
export type DocumentUpdate = z.input<typeof documentUpdateSchema>
export type NoteSave = z.input<typeof noteSaveSchema>
export type LinkSave = z.input<typeof linkSaveSchema>
