const crypto = require('crypto');

class SMS8Service {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://app.sms8.io/services/sendFront.php';
    }

    async sendSMS(phone, message) {
        try {
            // Format phone number (ensure +91 prefix)
            const formattedPhone = phone.startsWith('+91') ? phone :
                phone.startsWith('91') ? `+${phone}` :
                    `+91${phone.replace(/^\D+/g, '')}`;

            // Validate phone number
            if (!/^\+91\d{10}$/.test(formattedPhone)) {
                throw new Error('Invalid phone number format');
            }

            const payload = {
                key: this.apiKey,
                phone: formattedPhone,  // Send with +91 prefix
                msg: message,
                return: 'json'
            };

            console.log('Sending SMS with payload:', {
                ...payload,
                key: '***', // Hide API key in logs
                phone: formattedPhone // Log the formatted phone number
            });

            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'DynPro-VMS/1.0'
                },
                body: new URLSearchParams(payload)
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const text = await response.text();
            console.log('Raw SMS API Response:', text);

            let data;
            try {
                data = JSON.parse(text);
            } catch (e) {
                console.error('Failed to parse SMS API response:', e);
                throw new Error('Invalid response from SMS service');
            }

            if (data.status === 'success' || data.success === true) {
                console.log('SMS sent successfully:', {
                    phone: formattedPhone,
                    messageId: data.id || 'N/A'
                });
                return true;
            } else {
                throw new Error(data.message || 'SMS sending failed');
            }
        } catch (error) {
            console.error('SMS sending error details:', {
                error: error.message,
                phone,
                messageLength: message.length
            });
            throw error; // Re-throw to handle in calling code
        }
    }
}

module.exports = SMS8Service;
