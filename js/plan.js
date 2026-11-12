// Mokytojos „II kl. kalbėjimo pasiruošimo ir kalbos planas“ – vienas šaltinis ir UI, ir AI vertinimui.
export const STEPS = [
  {
    id: 'zanras',
    title: 'Žanras ir autorius',
    hint: 'Įvardink teksto žanrą ir autorių.',
    starters: [
      '… (autoriaus) straipsnis / interviu / reportažas / dienoraštis „…“',
      'Tai … parašytas publicistinio stiliaus tekstas – …',
    ],
  },
  {
    id: 'tema',
    title: 'Tema',
    hint: 'Apie ką šis kūrinys?',
    starters: ['Kūrinio tema – …', 'Tekste kalbama apie tai, kaip …'],
  },
  {
    id: 'tikslas',
    title: 'Tikslas ir adresatas',
    hint: 'Ko siekė autorius ir kam tekstas skirtas?',
    starters: [
      'Autoriaus tikslas buvo atskleisti / parodyti …',
      'Šis tekstas skirtas žmonėms, kurie domisi …, kuriems rūpi …, svarbu …',
    ],
  },
  {
    id: 'autoriaus_poziuris',
    title: 'Autoriaus požiūris ir problema',
    hint: 'Atskleisk autoriaus požiūrį, įvardink teksto problemą (problemas): kokiais argumentais ir pavyzdžiais autorius ją analizuoja, pristato, įrodo. Būtinai pacituok jo mintis.',
    starters: [
      'Tekste keliama problema – …',
      'Autorius teigia, kad …',
      'Savo mintį jis pagrindžia …',
      'Pasak autoriaus, „…“',
    ],
  },
  {
    id: 'savo_poziuris',
    title: 'Mano požiūris ir argumentai',
    hint: 'Ar sutinki su autoriumi? Pagrįsk SAVO argumentais: asmeninė patirtis (šeima, draugai), kultūrinė (filmai, spektakliai, parodos), literatūrinė (skaityti kūriniai – nebūtina, jei nėra tinkamo pavyzdžio), politinė, socialinė.',
    starters: [
      'Sutinku / nesutinku su autoriumi, nes …',
      'Iš savo patirties galiu pasakyti, kad …',
      'Tai primena filmą / knygą „…“, kur …',
    ],
  },
  {
    id: 'isvada',
    title: 'Išvada',
    hint: 'Apibendrink: įvardink pagrindinę teksto mintį, pasakyk, ar tema aktuali šiems laikams ir kodėl.',
    starters: ['Taigi …', 'Galima daryti išvadą, kad …', 'Ši tema šiandien aktuali, nes …'],
  },
];
