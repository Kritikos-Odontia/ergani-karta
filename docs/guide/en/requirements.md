# Requirements and known limits

## Computer and network

The desktop installation needs 64-bit Windows 10/11, macOS 13.5 or newer (Apple silicon or Intel), or 64-bit Linux (Ubuntu 22.04+, Debian 12+). Keep the computer on while staff work and sign into its user account each morning: the program starts **at user sign-in**, not before.

The staff page uses a private address, normally port 8880, over plain HTTP. Use the practice's password-protected WPA2/WPA3 Wi-Fi, not a guest or public network. Do not forward a port to the internet. Another building needs a private link, such as Tailscale, and a technical installation.

One employer per installation; one restricted login per branch; one running service per record store. Staff records contain tax identifiers and working hours. Keep them outside code folders and shared folders.

## What stays with the employer and accountant

The program does not do payroll, hiring, dismissal or schedule filings. The accountant handles schedule declarations and necessary corrections. The practice remains responsible for filings. Discuss coverage and document deliberate exemptions with the accountant; the program does not infer an exemption from a job title.

## Limits that affect your day

- **Split shifts:** how ΕΡΓΑΝΗ merges multiple intervals on the same day is unconfirmed. Stamp every arrival and departure. An older arrival that could overwrite a later declaration is referred to the accountant.
- **Missed-card indications:** use the same weekday in the latest available week of the previous month. Leave, holidays and changed schedules need checking. Without schedule reading, an open-shift indication appears at 21:00 and can miss a midday departure.
- **After an outage:** in this version, older approved late sends can delay a new card. Watch the page and unresolved cards.
- **Monthly archive:** ΕΡΓΑΝΗ answers one month behind. An unknown response shape is refused and shown as a problem, not as “no movements”. Findings come from a limited set of accounts.
- **Computer, power or network failure:** the page may be unavailable. Use [CardScanner only when the page cannot capture a card](daily.md).
- **Backups:** current automatic backups omit settings. Read [backup and recovery](backups.md) before treating them as a replacement-computer plan.
- **Closing a branch:** there is no removal command yet. Its settings remain because of its older cards.

Detailed technical limits are kept in [KNOWN-LIMITS.md](../../KNOWN-LIMITS.md) (English).
