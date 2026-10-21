## Τι αλλάζει και γιατί · What changes, and why

## Έλεγχος · Checklist

- [ ] `npm run typecheck` και `npm test` περνούν · pass
- [ ] Κανένα πραγματικό ΑΦΜ, όνομα, χρήστης ή κωδικός · No real ΑΦΜ, name, login or password
- [ ] Καμία νέα διαδρομή που γράφει κάρτα για άλλον · No new path that writes a card for someone else (docs/RULES.md, rule 1)
- [ ] Κανένα test δεν φτάνει στην ΕΡΓΑΝΗ· ο φράχτης στο `test/setup.ts` δεν άλλαξε · No test reaches ΕΡΓΑΝΗ; the fence is unchanged
- [ ] Ένα νέο test σπάει αν σπάσει ο κώδικας που φυλά · A new test goes red when the code it guards is broken
