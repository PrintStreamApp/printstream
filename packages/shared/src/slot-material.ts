/** PrintStream-owned slot identity, kept separate from the printer's restricted material preset. */
import { z } from 'zod'

export const slotMaterialIdentitySchema = z.object({
  brand: z.string().trim().max(80).nullable().transform((value) => value || null),
  filamentType: z.string().trim().min(1).max(60),
  materialSubtype: z.string().trim().max(60).nullable().transform((value) => value || null),
  colorName: z.string().trim().max(80).nullable().transform((value) => value || null)
})
export type SlotMaterialIdentity = z.infer<typeof slotMaterialIdentitySchema>
