import { z } from 'zod'

export const artifactChannelSchema = z.enum(['meeting', 'slack', 'email', 'chat'])

export const evidenceStatusSchema = z.enum(['supported', 'context_only', 'manual'])

export const claimKindSchema = z.enum([
  'relationship',
  'decision',
  'commitment',
  'status',
  'fact',
])

export const evidenceItemMutationSchema = z.object({
  artifactRef: z.string().optional(),
  sequenceNo: z.number().int().positive(),
  authorName: z.string().nullable().optional(),
  happenedAt: z.string().nullable().optional(),
  text: z.string().min(1),
  sourceAnchor: z.string().min(1),
  artifactChannel: artifactChannelSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
})

export const claimMutationSchema = z.object({
  claimKind: claimKindSchema,
  subjectEntityRef: z.string().min(1),
  predicate: z.string().min(1),
  objectEntityRef: z.string().nullable().optional(),
  objectValue: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1).default(1),
  evidenceStatus: evidenceStatusSchema.default('supported'),
  evidenceItemRefs: z.array(z.string().min(1)).default([]),
  manualStateInput: z.boolean().default(false),
  validFrom: z.string().nullable().optional(),
  validTo: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).superRefine((claim, ctx) => {
  if (!claim.manualStateInput && claim.evidenceItemRefs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Canonical claim mutations require linked evidence items unless manualStateInput=true',
      path: ['evidenceItemRefs'],
    })
  }
})

export const mutationBundleSchema = z.object({
  version: z.literal(1),
  source: z.enum(['channel_analyst', 'state_synthesizer', 'vault_author']),
  entities: z.array(z.object({
    entityType: z.string().min(1),
    name: z.string().min(1),
    canonicalName: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    attributes: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
  evidenceItems: z.array(evidenceItemMutationSchema).default([]),
  claims: z.array(claimMutationSchema).default([]),
  memories: z.array(z.record(z.string(), z.unknown())).default([]),
  decisionThreads: z.array(z.record(z.string(), z.unknown())).default([]),
  commitments: z.array(z.record(z.string(), z.unknown())).default([]),
  vaultDocuments: z.array(z.record(z.string(), z.unknown())).default([]),
})

export type ArtifactChannel = z.infer<typeof artifactChannelSchema>
export type ClaimKind = z.infer<typeof claimKindSchema>
export type MutationBundle = z.infer<typeof mutationBundleSchema>
