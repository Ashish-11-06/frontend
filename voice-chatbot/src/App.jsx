import { useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from '/vite.svg'
import './App.css'
import ChatBot from './Component/voiceConnection.jsx'
import VoiceBot from './Component/voiceConnection.jsx'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <div>
       <ChatBot />
       {/* <VoiceBot /> */}
      </div>
      <p className="read-the-docs">
        developed by Ashish and Aarti ( Prushal Technologyies)
      </p>
    </>
  )
}

export default App
