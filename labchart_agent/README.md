# LabChart comment agent

Runs on the **LabChart PC**. The stimulus runner (on the stimulus PC) sends it one line per played block,
the moment the block starts, and the agent puts that line into the running LabChart 8 recording as a
comment, through LabChart's own automation interface (`ADIChart.Application` →
`ActiveDocument.AppendComment(text, -1)`, all channels):

    #17 moving 45° · TF 2 Hz · C 50% · SF 0.02 c/px · 4 s · sine · [M045]

The comment says **what** played. **When** it played is still the photodiode on the corner marker, in its
own PowerLab channel; the block number in every comment ties each comment to its marker. A comment lands a
few ms after the onset (network + LabChart).

## Use

1. LabChart PC: open LabChart 8 with the document. Run `START-COM-TEST.bat` once: it puts a single test
   comment in without any network. If it appears, LabChart can be driven from this PC.
2. LabChart PC: run `START-AGENT.bat` and keep it open. It prints this PC's address, e.g. `10.1.2.3:8766`.
   The first time Windows may ask to allow network access; allow it.
3. Stimulus PC: write that address into `labchart.txt` next to `serve.py` (copy `labchart.txt.example`),
   then run `SEND-TEST-COMMENT.bat`: three test comments should appear in LabChart.
4. From then on the runner sends every block by itself; its banner says `LabChart: comments to …`.

`--allow <stimulus PC name or address>` restricts who may send; or put the stimulus PC's name (one per line) into `allow.txt` next to the agent and `START-AGENT.bat` uses it. A name is looked up at start and again if the PC's address changes; a name that cannot be found lets nobody in. Logs: `agent-log.txt`, `comments.csv` (every comment
and whether LabChart took it) here, and `logs/<session>.labchart.jsonl` on the stimulus PC (every block,
sent or not, with round-trip time). An unreachable agent never holds up the runner or its trial log.

Build the portable folder: `./build-agent-package.sh [out.zip]` (embeddable Python + comtypes; the test in
`../test/labchart_comments.test.py` must pass first).
