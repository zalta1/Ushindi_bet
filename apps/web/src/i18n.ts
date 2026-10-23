import { createI18n } from 'vue-i18n'

const sw = {
  home: 'Nyumbani', live: 'Mubashara', jackpots: 'Jakpoti', casino: 'Kasino', crash: 'Crash', promos: 'Promosheni', search: 'Tafuta mechi, ligi...', all: 'Zote', upcoming: 'Zinazokuja', betslip: 'Tiketi ya Kubeti', stake: 'Kiasi (TZS)', place: 'Weka Beti', potential: 'Malipo Yanayowezekana', balance: 'Salio', deposit: 'Weka Pesa', withdraw: 'Toa Pesa', login: 'Ingia', register: 'Jisajili', mybets: 'Beti Zangu', profile: 'Wasifu', virtuals: 'Virtuals', menu: 'Menyu', sports: 'Michezo', allSports: 'Michezo Yote', livescore: 'Matokeo Mubashara', printFixtures: 'Chapisha Ratiba', navSearch: 'Tafuta', collapse: 'Kunja paneli', expand: 'Panua paneli', admin: 'Msimamizi',
  phoneLabel: 'Simu (+255)', fullName: 'Jina kamili', dob: 'Tarehe ya kuzaliwa (18+)', password: 'Nenosiri', confirmPassword: 'Rudia nenosiri', forgot: 'Umesahau nenosiri?', forgotHelp: 'Ushindi haitumi SMS. Ingia kwenye wasifu ili kubadili nenosiri. Ikiwa umefungwa nje, wasiliana na msaada.', logout: 'Toka', changePassword: 'Badili nenosiri', currentPassword: 'Nenosiri la sasa', newPassword: 'Nenosiri jipya', adminDenied: 'Huna ruhusa ya msimamizi. Ukurasa huu ni kwa akaunti zenye jukumu la msimamizi tu.', adminSection: 'Jukumu lako halifungui sehemu hii.', saved: 'Imehifadhiwa', passwordChanged: 'Nenosiri limebadilishwa',
  errPhone: 'Nambari ya simu si sahihi. Tumia nambari ya Tanzania, mfano 07XXXXXXXX.', errPassword: 'Nenosiri liwe na herufi 12+, liwe na herufi na nambari.', errAge: 'Lazima uwe na miaka 18 au zaidi.', errPhoneTaken: 'Nambari hii tayari imesajiliwa. Ingia.', errCredentials: 'Simu au nenosiri si sahihi.', errLocked: 'Akaunti imefungwa kwa muda. Jaribu tena baadaye.', errRate: 'Maombi mengi sana. Jaribu tena baadaye.', errGeneric: 'Imeshindikana. Jaribu tena.', errMismatch: 'Manenosiri hayafanani.', errName: 'Andika jina kamili.',
}

const en = {
  home: 'Home', live: 'Live', jackpots: 'Jackpots', casino: 'Casino', crash: 'Crash', promos: 'Promotions', search: 'Search matches, leagues...', all: 'All', upcoming: 'Upcoming', betslip: 'Betslip', stake: 'Stake (TZS)', place: 'Place Bet', potential: 'Potential Payout', balance: 'Balance', deposit: 'Deposit', withdraw: 'Withdraw', login: 'Login', register: 'Register', mybets: 'My Bets', profile: 'Profile', virtuals: 'Virtuals', menu: 'Menu', sports: 'Sports', allSports: 'All Sports', livescore: 'Livescore', printFixtures: 'Print Fixtures', navSearch: 'Search', collapse: 'Collapse panel', expand: 'Expand panel', admin: 'Admin',
  phoneLabel: 'Phone (+255)', fullName: 'Full name', dob: 'Date of birth (18+)', password: 'Password', confirmPassword: 'Confirm password', forgot: 'Forgot password?', forgotHelp: 'Ushindi does not send SMS. Change your password from Profile while you are signed in. Contact support if you are locked out.', logout: 'Log out', changePassword: 'Change password', currentPassword: 'Current password', newPassword: 'New password', adminDenied: 'You do not have an admin role. This page is only for admin accounts.', adminSection: 'Your role cannot open this section.', saved: 'Saved', passwordChanged: 'Password changed',
  errPhone: 'That is not a Tanzanian mobile number. Use 07XXXXXXXX or +2557XXXXXXXX.', errPassword: 'Use at least 12 characters with a letter and a number.', errAge: 'You must be 18 or older.', errPhoneTaken: 'That number is already registered. Log in.', errCredentials: 'Wrong phone or password.', errLocked: 'This account is temporarily locked. Try again later.', errRate: 'Too many attempts. Try again later.', errGeneric: 'Something went wrong. Try again.', errMismatch: 'Passwords do not match.', errName: 'Enter your full name.',
}

export const i18n = createI18n({
  legacy: false,
  locale: localStorage.getItem('lang') || 'sw',
  fallbackLocale: 'en',
  messages: { sw: { ...sw }, en: { ...en } },
})
