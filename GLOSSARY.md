# PrintStream

PrintStream manages printer activity and retains the observations needed to understand past prints.

## Language

**Fault occurrence**:
One continuously reported printer problem from its first observation until PrintStream observes it clear. The same occurrence may affect several print jobs and idle periods.
_Avoid_: Error event, failed job

**Observed clear**:
The moment PrintStream receives a fresh report confirming that a previously reported fault is absent. This does not establish when the physical problem ended.
_Avoid_: Resolution time, repaired at

**Observation gap**:
A period when PrintStream cannot confirm a fault's state because the connection or server was unavailable. A gap does not establish that the fault cleared or returned.
_Avoid_: Clear, recurrence

**Carry-over fault**:
An occurrence already present when a print job or subsequent idle period begins.
_Avoid_: New fault, repeated fault

**Printer faults history entry**:
A standalone reference to a fault occurrence, shown alongside completed jobs for an observed idle period or to preserve access after its last associated job is deleted. The reference does not create another occurrence.
_Avoid_: Failed print

**Model provider**:
A model-sharing service, such as MakerWorld or Printables, from which a user chooses models to bring into PrintStream.

**Library folder**:
A named location within a PrintStream library that organizes saved files. It is distinct from a folder on the user's device.

**Import destination**:
The location in the PrintStream library that the user selects for a model being imported.
_Avoid_: Download folder, device folder
