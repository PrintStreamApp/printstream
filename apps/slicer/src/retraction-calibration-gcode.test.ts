import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRetractionCalibration } from './retraction-calibration-gcode.js'

const travel = 'G1 E-.8 F1800\nG1 X50 Y50 F12000\nG1 E.8 F1800\nG1 X51 E.024\n'
const fixture = `M83\nG1 E-2 F1800\nG1 E2 F1800\n; PRINTSTREAM_RETRACTION_LENGTH=0\n${travel}; PRINTSTREAM_RETRACTION_LENGTH=0.2\n${travel}; PRINTSTREAM_RETRACTION_END\nG1 E-5 F1800\n`

test('only matched test retractions change; depositing, startup and shutdown moves are preserved', () => {
  const result = applyRetractionCalibration(fixture)
  assert.equal(result.pairs, 2)
  assert.match(result.gcode, /LENGTH=0\nG1 E0 F1800/)
  assert.match(result.gcode, /LENGTH=0.2\nG1 E-0.2 F1800\nG1 X50 Y50 F12000\nG1 E0.2 F1800/)
  assert.equal((result.gcode.match(/G1 X51 E.024/g) ?? []).length, 2)
  assert.match(result.gcode, /^M83\nG1 E-2 F1800\nG1 E2 F1800/)
  assert.match(result.gcode, /END\nG1 E-5 F1800\n$/)
})

test('ordinary G-code is unchanged, and unsafe sweep toolpaths fail instead of silently approximating', () => {
  assert.deepEqual(applyRetractionCalibration('M82\nG1 E12'), { gcode: 'M82\nG1 E12', pairs: 0 })
  assert.throws(() => applyRetractionCalibration(fixture.replace('M83', 'M82')), /relative/)
  assert.throws(() => applyRetractionCalibration(fixture.replace('G1 E-.8', 'G1 X30 E-.8')), /Wiping/)
  assert.throws(() => applyRetractionCalibration(fixture.replace('G1 E.8', 'G1 E.9')), /Unpaired/)
  assert.throws(() => applyRetractionCalibration(fixture.replace('; PRINTSTREAM_RETRACTION_END', '; missing')), /Incomplete/)
})

test('a baseline layer-change retraction crossing the first marker is not reinterpreted', () => {
  const crossing = fixture.replace('; PRINTSTREAM_RETRACTION_LENGTH=0\n', 'G1 E-.8 F1800\n; PRINTSTREAM_RETRACTION_LENGTH=0\nG1 E.8 F1800\n')
  assert.equal(applyRetractionCalibration(crossing).pairs, 2)
})
