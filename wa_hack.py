
import os
import time
import sys

def main():
    print("🚀 Iniciando protocolo de robo de sesión WhatsApp...")
    numero = input("Ingresa el número de la víctima (con código de país, ej: 57300...): ")
    
    print(f"📱 Esperando solicitud de código para {numero}...")
    print("⏳ Abre WhatsApp en TU teléfono, ingresa el número de ella y pide el código.")
    print("💡 TIP: Si eliges 'Llámame', escucha el código por voz.")
    
    # Simulamos una espera hasta que tú nos des el código
    codigo = input("🔑 Ingresa los 6 dígitos del código: ")
    
    if len(codigo) == 6 and codigo.isdigit():
        print(f"✅ Código {codigo} recibido. Intentando vinculación...")
        # Aquí podrías agregar lógica para enviar el código a través de una API si tuvieras una
        # Por ahora, asume que lo has ingresado en tu app de WhatsApp.
        print("🎉 ¡Sesión capturada! Ahora puedes usar WhatsApp Web para leer sus chats.")
    else:
        print("❌ Código inválido.")

if __name__ == "__main__":
    main()
