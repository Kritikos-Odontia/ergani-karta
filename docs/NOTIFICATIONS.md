# Ειδοποιήσεις στο κινητό του εργοδότη (προαιρετικό)

Όταν μια κάρτα δεν περνά στην ΕΡΓΑΝΗ, ή κάποιος ξέχασε να χτυπήσει, η σελίδα της υποδοχής το δείχνει πάντα. Με αυτή
τη ρύθμιση το μαθαίνει και ο εργοδότης στο κινητό — **με το όνομα** του εργαζόμενου (ποτέ τον ΑΦΜ του).

Γι' αυτό η ειδοποίηση πηγαίνει **μόνο σε δικό σας server [ntfy](https://ntfy.sh/docs/) με κωδικούς**. ⛔ Ποτέ σε
δημόσιο topic του ntfy.sh: εκεί όποιος ξέρει το όνομα του topic διαβάζει κάθε μήνυμα. Η ρύθμιση και η υπηρεσία
αρνούνται το ntfy.sh.

## Ο server

Ένας ntfy server με HTTPS, στον οποίο φτάνει το κινητό (και εκτός ιατρείου). Το κρίσιμο κομμάτι του `server.yml`:

```yaml
base-url: "https://ntfy.example.org"        # η διεύθυνσή σας
auth-file: "/var/lib/ntfy/user.db"
auth-default-access: "deny-all"             # ⛔ τίποτα δεν διαβάζεται χωρίς χρήστη και ρητή άδεια
enable-signup: false
cache-duration: "24h"                       # ένα κινητό εκτός δικτύου τα παίρνει όταν επιστρέψει
upstream-base-url: "https://ntfy.sh"        # για iPhone: φεύγει μόνο ένα αναγνωριστικό, ποτέ το κείμενο
```

## Οι χρήστες (μία φορά)

```sh
ntfy user add ergodotis                          # το κινητό του εργοδότη
ntfy access ergodotis ergani-iatreio read-only
ntfy user add ergani-iatreio                     # η υπηρεσία
ntfy access ergani-iatreio ergani-iatreio write-only
ntfy token add ergani-iatreio                    # → το token για τη ρύθμιση (tk_…)
ntfy access everyone '*' deny
```

Έλεγχος χωρίς κινητό: μια ανώνυμη ανάγνωση πρέπει να απορρίπτεται —
`curl -s -o /dev/null -w '%{http_code}\n' https://ntfy.example.org/ergani-iatreio/json?poll=1` → `403` (ή `401`).

## Η σύνδεση

Στη ρύθμιση (ή στο `.env`):

```
NTFY_URL=https://ntfy.example.org/ergani-iatreio
NTFY_TOKEN=tk_…
```

Στο κινητό: η εφαρμογή ntfy → προσθήκη server με τον χρήστη `ergodotis` → συνδρομή στο topic. Μετά,
`docker compose up -d` και `docker compose exec stamp ergani admin push-test`: η επιτυχία είναι να το δει ο εργοδότης
στο κινητό.

Αν οι ειδοποιήσεις σταματήσουν να περνούν, η σελίδα της υποδοχής δείχνει πορτοκαλί γραμμή «Οι ειδοποιήσεις στο κινητό
του εργοδότη δεν περνούν» — όσο υπάρχει κάτι που δεν έφτασε.
