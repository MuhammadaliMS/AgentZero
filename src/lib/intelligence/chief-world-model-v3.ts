import { isFeatureEnabled } from '@/lib/evidence/flags'
import {
  selectChangedInitiatives,
  type InitiativeRecord,
} from '@/lib/intelligence/initiative-state'

export interface ChiefWorldModelV3Plan {
  enabled: boolean
  changedInitiativeIds: string[]
}

export function resolveChiefWorldModelV3Plan(input: {
  orgSettings?: Record<string, unknown> | null
  previousInitiatives: InitiativeRecord[]
  nextInitiatives: InitiativeRecord[]
}): ChiefWorldModelV3Plan {
  const enabled = isFeatureEnabled('chief_world_model_v3', input.orgSettings)
  if (!enabled) {
    return {
      enabled: false,
      changedInitiativeIds: input.nextInitiatives.map((initiative) => initiative.id),
    }
  }

  return {
    enabled: true,
    changedInitiativeIds: selectChangedInitiatives({
      previous: input.previousInitiatives,
      next: input.nextInitiatives,
    }),
  }
}
