# Ρυθμίσεις και παραρτήματα

Στο πρόγραμμα υπολογιστή, ανοίξτε **Ρυθμίσεις** από τις σελίδες του εργοδότη και συνδεθείτε με τον κωδικό εργοδότη.
Όλα γίνονται στον υπολογιστή που τρέχει το πρόγραμμα. Οι ρυθμίσεις δεν χτυπούν κάρτα για κανέναν.

- **Σύνδεση ΕΡΓΑΝΗ:** στο παράρτημα, ανοίξτε «Αλλαγή σύνδεσης ΕΡΓΑΝΗ» και γράψτε τον νέο περιορισμένο χρήστη και
  δύο φορές τον νέο κωδικό. Ο παλιός κωδικός δεν εμφανίζεται ποτέ. Αποθηκεύονται με την ίδια προστασία που έχει το
  αρχικό αρχείο ρυθμίσεων (ιδιωτικό αρχείο στον υπολογιστή, δικαιώματα 0600· `Secret` στον πελάτη ΕΡΓΑΝΗ).
  Ακολουθεί έλεγχος σύνδεσης μόνο ανάγνωσης: αν ο χρήστης συνδέεται και αν εμφανίζεται η `WRKCardSE` στη λίστα
  εντύπων του. Δεν στέλνεται κάρτα. Ο έλεγχος **δεν αποδεικνύει** ότι ο χρήστης ανήκει στο σωστό παράρτημα, ότι
  έχει μόνο αυτό το δικαίωμα ή ότι μια υποβολή θα πετύχει. Επιβεβαιώστε εσείς στην ΕΡΓΑΝΗ τους περιορισμούς του
  χρήστη, όπως στο [ERGANI-USER.md](ERGANI-USER.md). Αν αποτύχει, οι νέοι κωδικοί παραμένουν αποθηκευμένοι και τους
  διορθώνετε από την ίδια σελίδα.
- **Κωδικός εργοδότη:** γράψτε τον παλιό και δύο φορές τον νέο (τουλάχιστον 10 χαρακτήρες). Με την αλλαγή κλείνουν
  όλες οι υπάρχουσες συνδέσεις εργοδότη· συνδεθείτε ξανά με τον νέο. Πέντε λάθος παλιοί κωδικοί εμποδίζουν άλλες
  δοκιμές αλλαγής για 10 λεπτά. Ο κωδικός κρατιέται μόνο ως προστατευμένο αποτύπωμα, όπως στην πρώτη ρύθμιση.
- **Όνομα ιατρείου ή εργαζομένου:** διορθώστε τα πεδία και αποθηκεύστε. Το αρχικό όνομα και η διόρθωση κρατιούνται
  ως ξεχωριστά γεγονότα. Οι παλιές κάρτες κρατούν ακριβώς το όνομα που είχαν όταν χτυπήθηκαν — ακόμη κι αν δεν έχουν
  σταλεί ακόμη. Ο ΑΦΜ δεν αλλάζει. Η διόρθωση εδώ δεν αλλάζει το μητρώο της ΕΡΓΑΝΗ· αν εκεί υπάρχει λάθος, ενημερώστε
  τον λογιστή.
- **Νέο παράρτημα:** χρησιμοποιήστε τον αριθμό που έχει ήδη στην ΕΡΓΑΝΗ (η έδρα είναι `0`), ένα όνομα και τον δικό
  του περιορισμένο χρήστη. Επιλέξτε αν διαβάζεται το σταθερό δηλωμένο ωράριό του. Γίνεται ο ίδιος έλεγχος σύνδεσης.
  Μετά εγγράψτε τη συσκευή υποδοχής του από τις **Συσκευές**. Η προσθήκη εδώ δεν ιδρύει παράρτημα στην ΕΡΓΑΝΗ.
- **Μετονομασία παραρτήματος:** αλλάζει το όνομα που δείχνει η σελίδα, με καταγραφή της διόρθωσης. Ο αριθμός και
  οι παλιές κάρτες διατηρούνται.
- **Απόσυρση παραρτήματος:** μόνο όταν κανείς δεν εργάζεται πια εκεί. Η σελίδα του παύει να δέχεται νέες κάρτες,
  ακόμη και από συσκευή ήδη εγγεγραμμένη. Το παράρτημα, οι κάρτες, οι αποδείξεις και ο περιορισμένος χρήστης
  παραμένουν: συνεχίζονται οι αποστολές που εκκρεμούν, η λήψη αποδείξεων και το μηνιαίο αρχείο. Δεν γίνεται διαγραφή
  ούτε κλείσιμο του παραρτήματος στην ΕΡΓΑΝΗ. Η επανενεργοποίηση δεν διατίθεται από τη σελίδα.

Η σελίδα εργαζομένων ξανανοίγει προσωρινά με τις νέες ρυθμίσεις όταν αλλάζετε σύνδεση, όνομα ιατρείου ή παράρτημα.
Ολοκληρώνεται πρώτα η αποστολή που βρίσκεται σε εξέλιξη, και μετά ξεκινά η υπηρεσία με τις νέες ρυθμίσεις. Ένας
μηνιαίος έλεγχος που ήδη τρέχει ολοκληρώνεται με την προηγούμενη σύνδεση· ο επόμενος παίρνει τη νέα.

Το αρχείο ρυθμίσεων και οι παλιές εντολές συνεχίζουν να λειτουργούν. Η σελίδα αλλάζει μόνο τα απαραίτητα πεδία και
κρατά τις υπόλοιπες επιλογές. Αν προσθέσετε παράρτημα απευθείας στο αρχείο του προγράμματος υπολογιστή, η επόμενη
εκκίνηση καταγράφει και την προσθήκη του στο αρχείο καρτών. Η αφαίρεση παλιού παραρτήματος από τις ρυθμίσεις παραμένει
σφάλμα: αποσύρετέ το από τη σελίδα, μην αφαιρείτε τον χρήστη του. Οι τεχνικές εγκαταστάσεις Docker συνεχίζουν να
ακολουθούν το [ADMIN.md](ADMIN.md).

---

# Settings and branches

In the desktop program, sign in to the owner's pages and open **Ρυθμίσεις** (Settings). These actions never stamp a
card on anyone's behalf.

- Change each branch's restricted ΕΡΓΑΝΗ login and enter the new password twice. The old password is never shown.
  The program keeps the existing private settings file protection (0600) and the client's `Secret` handling. It then
  checks sign-in and whether `WRKCardSE` appears in the forms list, without submitting anything. This does not prove
  the branch identity, restricted permissions or successful filing: verify the permissions yourself in ΕΡΓΑΝΗ using
  [ERGANI-USER.md](ERGANI-USER.md). Failed new credentials stay saved and can be corrected on the same page.
- Change the owner password by supplying the old one and entering the new one twice (at least 10 characters).
  Existing owner sessions are signed out. Five wrong old-password attempts lock further changes for 10 minutes.
- Correct the practice or employee name. The original and correction remain recorded as separate facts; old cards,
  including cards still waiting to be sent, retain their captured names. An employee's tax identifier cannot change.
  These corrections do not change the ΕΡΓΑΝΗ register; contact the accountant if that needs correcting.
- Add a branch using its existing ministry number, a label and its own restricted login. Choose whether its standing
  schedule is read; the connection check runs afterwards. Then enrol its reception device under **Συσκευές**
  (Devices). Adding it here does not register a branch with the ministry.
- Rename a branch without changing its number or old cards. Retire it only after work there has stopped. Retired
  branches refuse new cards, including on already enrolled devices. History, receipts, pending submissions, logins
  and archive reads remain available. Retirement does not close the branch at the ministry. The screen does not
  offer reactivation.

Changing the connection, practice name or branches briefly reopens the staff service after its current send
finishes. An archive run already in progress finishes with its original connection; the next run uses the new one.
Existing settings files and commands remain supported. The desktop program also completes a configured branch
addition at its next start if the computer stopped between saving the settings and recording that addition.
Never remove an old branch's login from the settings: retire the branch on screen instead. Docker installations
continue to use [ADMIN.md](ADMIN.md).
