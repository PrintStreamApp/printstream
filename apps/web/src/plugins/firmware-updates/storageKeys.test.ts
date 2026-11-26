/** plugin:firmware-updates's browser storage key declarations against the shared contract (`test-utils/storageKeyContract.ts`). */
import { testStorageKeyDeclarations } from '../../test-utils/storageKeyContract'
import * as storageKeys from './storageKeys'

testStorageKeyDeclarations('plugin:firmware-updates', storageKeys)
