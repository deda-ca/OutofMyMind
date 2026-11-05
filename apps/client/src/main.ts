import 'bootstrap/dist/css/bootstrap.min.css'
import { createApp } from 'vue'
import App from './App.vue'
import { checkSignedIn, watchForSignOut } from './auth'

watchForSignOut()
void checkSignedIn()

createApp(App).mount('#app')
