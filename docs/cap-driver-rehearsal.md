# CAP Driver rehearsal without a cashier

The RBS/MAT **CAP Driver** path (`ecr/protocols/cap_driver.rs`) talks to the
fiscal cashier only through the vendor's Windows service: POS drops a command
file in the capture folder, `CapDriverSVC` prints the receipt and answers with
an `Output/<same name>` file plus a line in `CapDriverSVC_log.txt`, then deletes
the command file. Nothing in POS opens the cashier socket itself.

That makes the flow rehearsable on any PC: `scripts/fake-capdriver.mjs` plays
the service. It consumes command files, answers in the same format, and can be
told to decline cards, take its time on the terminal, or never answer at all.

## Adapter settings that matter on site

All of them live in the cash-register device `settings` JSON and are exposed
under *Settings → Peripherals → Cash register* when the protocol is CAP Driver.

| Setting | Default | When to change it |
| --- | --- | --- |
| `capturePath` / `outputPath` | `C:\Capture` / `C:\Capture\Output` | Must match the folders configured in the CAP Driver installer. |
| `fileEncoding` | `utf-8` | Set `windows-1253` when the installer is configured for ANSI 1253 (the EMDI/Pegasus RBS guides do this). Applies to the command files POS writes **and** to how POS reads the service's Output/log files. A mismatch prints `ΜΕΤΡΗΤΑ`/`ΚΑΡΤΑ` as mojibake or misses the `Error 0x..` markers. |
| `probeDeviceTcp` | `false` | Turn on only when the service reaches the cashier over TCP and you want POS to refuse to connect while the cashier port is closed. RBS ELIO links are frequently UDP or serial behind the service, where a TCP probe fails although receipts print fine. |
| `requireService` | `true` | Turn off **only** while rehearsing with the fake service. A real cashier always needs `CapDriverSVC` running. |
| `transactionTimeoutMs` | `120000` | How long POS waits for the service to consume the command file. Card payments wait on the bank terminal inside this window. |
| `eftPosIndex`, `cashPaymentCode`, `cardPaymentCode` | `1`, `1`, `2` | Must match the paired EFT POS number and the payment codes programmed in the cashier. |

Unsupported `fileEncoding` values fail the connection with a clear message
instead of silently falling back to UTF-8.

## Running the fake service

```bash
node scripts/fake-capdriver.mjs --capture C:\Capture
```

Then in POS: add a cash-register device, protocol **CAP Driver**, connection
**Network** (any IP/port; the probe is off by default), capture/output folders
pointing at the same directories, and **untick "Require the Windows service"**.
*Test Connection* drops an `XX/` (X report) command; a cash or card checkout
drops the receipt file. The fake prints what it "received" and what it
answered.

| Rehearsal | Command | Expected POS outcome |
| --- | --- | --- |
| Happy path, cash | `--eft-delay-ms 0` | Receipt approved, order closes. |
| Happy path, card | default (`--eft-delay-ms 3000`) | POS waits ~3 s ("terminal"), then approved. |
| ANSI 1253 site | `--encoding windows-1253` with the device set to ANSI 1253 | Same as above; the fake receives single-byte Greek and answers in kind. Leave the device on UTF-8 to see the mismatch. |
| Card declined | `--fail LR=0x42` | POS reports `CAP Driver reported device error 0x42`; the receipt is cancelled, order stays open. |
| Item rejected | `--fail SL=0x11` | Error before any payment; nothing printed. |
| Slow service | `--consume-delay-ms 130000` | POS gives up after `transactionTimeoutMs` and reports the ambiguous outcome; the fake still "prints" afterwards, which is exactly the double-receipt hazard to handle on site. |
| Service dead | `--hang` | Command file stays in the folder; POS times out with the ambiguous outcome. |
| Service missing | stop the fake, keep `requireService` off | Folder checks pass but nothing consumes the file; same as `--hang`. |

`--once` processes what is pending and exits (used by the tests);
`--quiet` silences the receipt rendering.

## What the fake does not prove

- Whether the installed `CapDriverSVC` is set to UTF-8 or ANSI 1253. Read the
  installer setting on site and set `fileEncoding` to match.
- Whether the cashier's department numbers and VAT mapping match the POS tax
  rates. The first live receipt with one line per VAT rate proves that.
- Whether the paired EFT POS index and the payment codes are the ones the
  cashier was programmed with.
- Timing of the real bank terminal. Use `--eft-delay-ms` to rehearse the UI,
  not to size `transactionTimeoutMs`.

## Automated coverage

- `src-tauri/src/ecr/codepage.rs`: Windows-1253 encode/decode round-trips.
- `src-tauri/src/ecr/protocols/cap_driver.rs` tests: encoding of the payment
  lines, opt-in TCP probe, and an in-process fake service that approves and
  declines a card receipt in ANSI 1253.
- `tests/scripts/fake-capdriver.test.ts` (parity suite): the script consumes,
  answers, declines, hangs, and refuses unknown flags.
