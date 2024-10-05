import { IController } from '../utils/icontroller';
import { ExtendedRequest, verifyToken } from '../middlewares/auth'
import express, { Response, Router } from "express";
import { Admin } from '../utils/cognito-client'
import DB from '../utils/db-client'
import { detectAndDecodeContent, isValidEmail, isValidId, isValidPhoneNumber, isValidString } from "../utils/validate";
import process from "node:process";
import { generatePaginationLinks } from "../utils/helper";
import { MockCognitoClient } from '../utils/mock-cognito-client';
import multer from 'multer';
import { Readable } from 'node:stream';
import csv from 'csv-parser';


const storage = multer.memoryStorage();
const upload = multer({ storage });
class AdminController implements IController {
    public router: Router = express.Router();
    public cognitoClient: any;

    constructor() {
        this.cognitoClient = process.env.USE_MOCK_COGNITO === 'true' ? MockCognitoClient : Admin;
        this.initRoutes()
    }

    initRoutes(): void {
        this.router.post('/admin/create', verifyToken, this.createAdmin)
        this.router.get('/admin/list', verifyToken, this.adminList)
        this.router.post('/admin/upload', verifyToken, upload.single('file'), this.uploadAdminsFromCSV);
        this.router.get('/admin/export', verifyToken, this.exportAdminsToCSV)
        this.router.get('/admin/:id', verifyToken, this.adminView)
        this.router.put('/admin/:id', verifyToken, this.adminEdit)
        this.router.delete('/admin/:id', verifyToken, this.adminDelete)
    }

    exportAdminsToCSV = async (req: ExtendedRequest, res: Response) => {
        try {
            const admins = await DB.query(`SELECT
                email, phone_number, given_name, family_name
                FROM Admin
                WHERE school_id = :school_id`, {
                school_id: req.user.school_id
            });

            if (admins.length === 0) {
                return res.status(404).json({
                    error: 'No admins found'
                }).end();
            }

            const csvHeaders = ['email', 'phone_number', 'given_name', 'family_name'];
            const csvRows = admins.map((admin: any) =>
                `${admin.email},${admin.phone_number},${admin.given_name},${admin.family_name}`
            );

            const csvContent = [csvHeaders.join(','), ...csvRows].join('\n');

            res.setHeader('Content-Disposition', 'attachment; filename="admins.csv"');
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.send(Buffer.from('\uFEFF' + csvContent, 'utf-8'));
        } catch (e: any) {
            return res.status(500).json({
                error: 'Internal server error',
                details: e.message
            }).end();
        }
    }

    uploadAdminsFromCSV = async (req: ExtendedRequest, res: Response) => {
        const { throwInError, action, withCSV } = req.body;
        const throwInErrorBool = throwInError === 'true';
        const withCSVBool = withCSV === 'true';

        const results: any[] = [];
        const errors: any[] = [];
        const inserted: any[] = [];
        const updated: any[] = [];
        const deleted: any[] = [];

        try {
            if (!req.file || !req.file.buffer) {
                return res.status(400).json({
                    error: 'Bad Request',
                    details: 'File is missing or invalid'
                }).end();
            }

            const decodedContent = await detectAndDecodeContent(req.file.buffer);

            const stream = Readable.from(decodedContent)
            await new Promise((resolve, reject) => {
                stream
                    .pipe(csv())
                    .on('headers', (headers: any) => {
                        if (headers[0].charCodeAt(0) === 0xFEFF) {
                            headers[0] = headers[0].substring(1);
                        }
                    })
                    .on('data', (data: any) => {
                        if (Object.values(data).some((value: any) => value.trim() !== '')) {
                            results.push(data);
                        }
                    })
                    .on('end', resolve)
                    .on('error', reject);
            });

            const validResults: any[] = []
            const existingEmailsInCSV: string[] = []
            for (const row of results) {
                const { email, phone_number, given_name, family_name } = row;
                const rowErrors: any = {};
                const normalizedEmail = String(email).trim();
                const normalizedPhoneNumber = Number(phone_number).toString();
                const normalizedGiven = String(given_name).trim();
                const normalizedFamily = String(family_name).trim();

                if (!isValidEmail(normalizedEmail)) rowErrors.email = 'Invalid email';
                if (!isValidPhoneNumber(normalizedPhoneNumber)) rowErrors.phone_number = 'Invalid phone number';
                if (!isValidString(normalizedGiven)) rowErrors.given_name = 'Invalid given name';
                if (!isValidString(normalizedFamily)) rowErrors.family_name = 'Invalid family name';
                if (existingEmailsInCSV.includes(normalizedEmail)) {
                    rowErrors.email = 'This email already exists'
                }

                if (Object.keys(rowErrors).length > 0) {
                    errors.push({ row, errors: rowErrors });
                } else {
                    row.email = normalizedEmail;
                    row.phone_number = normalizedPhoneNumber;
                    row.given_name = normalizedGiven
                    row.family_name = normalizedFamily
                    existingEmailsInCSV.push(row.email)

                    validResults.push(row);
                }
            }

            if (errors.length > 0 && throwInErrorBool) {
                return res.status(400).json({ errors: errors }).end();
            }

            const emails = validResults.map(row => row.email);
            if (emails.length === 0) {
                return res.status(400).json({
                    errors: errors,
                    message: 'All data invalid'
                }).end();
            }
            const existingAdmins = await DB.query('SELECT email FROM Admin WHERE email IN (:emails)', {
                emails,
            });
            const existingEmails = existingAdmins.map((admin: any) => admin.email);

            if (action === 'create') {
                for (const row of validResults) {
                    if (existingEmails.includes(row.email)) {
                        errors.push({ row, errors: { email: 'Admin already exists' } });
                    } else {
                        await this.cognitoClient.register(row.email)
                        await DB.execute(
                            `INSERT INTO Admin(cognito_sub_id, email, phone_number, given_name, family_name, school_id)
                            VALUE (:cognito_sub_id, :email, :phone_number, :given_name, :family_name, :school_id);`, {
                            cognito_sub_id: row.email,
                            email: row.email,
                            phone_number: row.phone_number,
                            given_name: row.given_name,
                            family_name: row.family_name,
                            school_id: req.user.school_id,
                        });
                        inserted.push(row);
                    }
                }
            } else if (action === 'update') {
                for (const row of validResults) {
                    if (!existingEmails.includes(row.email)) {
                        errors.push({ row, errors: { email: 'Admin does not exist' } });
                    } else {
                        await DB.execute(
                            `UPDATE Admin SET
                        phone_number = :phone_number,
                        given_name = :given_name,
                        family_name = :family_name
                    WHERE email = :email`, {
                            email: row.email,
                            phone_number: row.phone_number,
                            given_name: row.given_name,
                            family_name: row.family_name,
                        });
                        updated.push(row);
                    }
                }
            } else if (action === 'delete') {
                for (const row of validResults) {
                    if (!existingEmails.includes(row.email)) {
                        errors.push({ row, errors: { email: 'Admin does not exist' } });
                    } else {
                        await this.cognitoClient.delete(row.email)
                        await DB.execute('DELETE FROM Admin WHERE email = :email AND school_id = :school_id', {
                            email: row.email,
                            school_id: req.user.school_id,
                        });
                        deleted.push(row);
                    }
                }
            } else {
                return res.status(400).json({
                    error: 'Bad Request',
                    details: 'Invalid action'
                }).end();
            }

            if (errors.length > 0) {
                let csvFile: Buffer | null = null;
                if (withCSVBool) {
                    const csvHeaders = ['email', 'phone_number', 'given_name', 'family_name'];
                    const csvRows = errors.map((error: any) =>
                        `${error?.row?.email},${error?.row?.phone_number},${error?.row?.given_name},${error?.row?.family_name}`
                    );

                    const csvContent = [csvHeaders.join(','), ...csvRows].join('\n');
                    // response headers for sending multipart files to send it with json response
                    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                    res.setHeader('Content-Disposition', 'attachment; filename=errors.csv');

                    csvFile = Buffer.from('\uFEFF' + csvContent, 'utf-8')
                }

                return res.status(400).json({
                    message: 'CSV processed successfully but with errors',
                    inserted: inserted,
                    updated: updated,
                    deleted: deleted,
                    errors: errors.length > 0 ? errors : null,
                    csvFile: csvFile,
                }).end()
            }

            return res.status(200).json({
                message: 'CSV processed successfully',
                inserted: inserted,
                updated: updated,
                deleted: deleted,
            }).end()
        } catch (e: any) {
            return res.status(500).json({
                error: 'Internal server error',
                details: e.message
            }).end();
        }
    }

    adminDelete = async (req: ExtendedRequest, res: Response) => {
        try {
            const adminId = req.params.id;


            if (!adminId || !isValidId(adminId)) {
                throw {
                    status: 401,
                    message: 'Invalid or missing admin id'
                }
            }
            const adminInfo = await DB.query(`SELECT 
                id, cognito_sub_id, email, 
                phone_number, given_name, 
                family_name, created_at, last_login_at 
                FROM Admin
                WHERE id = :id AND school_id = :school_id`, {
                id: adminId,
                school_id: req.user.school_id
            });

            if (adminInfo.length <= 0) {
                throw {
                    status: 404,
                    message: 'Admin not found'
                }
            }

            const admin = adminInfo[0];

            await this.cognitoClient.delete(admin.email)

            await DB.execute('DELETE FROM Admin WHERE id = :id;', {
                id: admin.id
            })

            return res.status(200).json({
                message: 'Admin deleted successfully'
            }).end()
        } catch (e: any) {
            if (e.status) {
                return res.status(e.status).json({
                    error: e.message
                }).end();
            } else {
                return res.status(500).json({
                    error: 'Internal server error'
                }).end();
            }
        }
    }

    adminEdit = async (req: ExtendedRequest, res: Response) => {
        try {
            const {
                phone_number,
                given_name,
                family_name,
            } = req.body

            if (!phone_number || !isValidPhoneNumber(phone_number)) {
                throw {
                    status: 401,
                    message: 'Invalid or missing phone number'
                }
            }
            if (!given_name || !isValidString(given_name)) {
                throw {
                    status: 401,
                    message: 'Invalid or missing given name'
                }
            }
            if (!family_name || !isValidString(family_name)) {
                throw {
                    status: 401,
                    message: 'Invalid or missing family name'
                }
            }

            const adminId = req.params.id;



            if (!adminId || !isValidId(adminId)) {
                throw {
                    status: 401,
                    message: 'Invalid or missing admin id'
                }
            }
            const adminInfo = await DB.query(`SELECT id, 
                       email, phone_number, 
                       given_name, family_name, 
                       created_at 
                FROM Admin
                WHERE id = :id AND school_id = :school_id`, {
                id: adminId,
                school_id: req.user.school_id
            });

            if (adminInfo.length <= 0) {
                throw {
                    status: 404,
                    message: 'Admin not found'
                }
            }

            const admin = adminInfo[0];

            const findDuplicates = await DB.query('SELECT id, phone_number FROM Admin WHERE phone_number = :phone_number', {
                phone_number: phone_number,
            })

            if (findDuplicates.length >= 1) {
                const duplicate = findDuplicates[0];
                if (duplicate.id != adminId) {
                    if (phone_number == duplicate.phone_number) {
                        throw {
                            status: 401,
                            message: 'This phone_number already exists'
                        }
                    }
                }
            }

            await DB.execute(
                `UPDATE Admin SET                    
                        phone_number = :phone_number,
                        family_name = :family_name,
                        given_name = :given_name
                    WHERE id = :id`, {
                phone_number: phone_number,
                given_name: given_name,
                family_name: family_name,
                id: admin.id
            });

            return res.status(200).json({
                admin: {
                    id: admin.id,
                    email: admin.email,
                    phone_number: phone_number,
                    given_name: given_name,
                    family_name: family_name,
                }
            }).end()
        } catch (e: any) {
            if (e.status) {
                return res.status(e.status).json({
                    error: e.message
                }).end();
            } else {
                return res.status(500).json({
                    error: 'Internal server error'
                }).end();
            }
        }
    }

    adminView = async (req: ExtendedRequest, res: Response) => {
        try {
            const adminId = req.params.id;


            if (!adminId || !isValidId(adminId)) {
                throw {
                    status: 401,
                    message: 'Invalid or missing admin id'
                }
            }
            const adminInfo = await DB.query(`SELECT id,
                       email,
                       phone_number,
                       given_name,
                       family_name,
                       created_at
                FROM Admin
                WHERE id = :id
                AND school_id = :school_id`, {
                id: adminId,
                school_id: req.user.school_id
            });

            if (adminInfo.length <= 0) {
                throw {
                    status: 404,
                    message: 'Admin not found'
                }
            }

            const admin = adminInfo[0];

            return res.status(200).json({
                admin: admin
            }).end()
        } catch (e: any) {
            if (e.status) {
                return res.status(e.status).json({
                    error: e.message
                }).end();
            } else {
                return res.status(500).json({
                    error: 'Internal server error'
                }).end();
            }
        }
    }

    adminList = async (req: ExtendedRequest, res: Response) => {
        try {
            const page = parseInt(req.query.page as string) || 1;
            const limit = parseInt(process.env.PER_PAGE + '');
            const offset = (page - 1) * limit;

            const email = req.query.email as string || '';
            const phone_number = req.query.phone_number as string || '';
            const name = req.query.name as string || '';

            const filters = [];
            const params: any = {
                school_id: req.user.school_id,
                limit: limit,
                offset: offset
            };

            if (email) {
                filters.push('email LIKE :email');
                params.email = `%${email}%`;
            }
            if (phone_number) {
                filters.push('phone_number LIKE :phone_number');
                params.phone_number = `%${phone_number}%`;
            }
            if (name) {
                filters.push('(given_name LIKE :name OR family_name LIKE :name)');
                params.name = `%${name}%`;
            }


            const whereClause = filters.length > 0 ? 'AND ' + filters.join(' AND ') : '';

            const adminList = await DB.query(`SELECT 
                id, email, phone_number, given_name, family_name 
                FROM Admin
                WHERE school_id = :school_id ${whereClause}
                ORDER BY id DESC
                LIMIT :limit OFFSET :offset;`, params);

            const totalAdmins = (await DB.query(`SELECT COUNT(*) as total
                FROM Admin WHERE school_id = :school_id ${whereClause};`, params))[0].total

            const totalPages = Math.ceil(totalAdmins / limit);

            const pagination = {
                current_page: page,
                per_page: limit,
                total_pages: totalPages,
                total_admins: totalAdmins,
                next_page: page < totalPages ? page + 1 : null,
                prev_page: page > 1 ? page - 1 : null,
                links: generatePaginationLinks(page, totalPages)
            };

            return res.status(200).json({
                admins: adminList,
                pagination: pagination
            }).end();
        } catch (e: any) {
            if (e.status) {
                return res.status(e.status).json({
                    error: e.message
                }).end();
            } else {
                return res.status(500).json({
                    error: 'Internal server error'
                }).end();
            }
        }
    }

    createAdmin = async (req: ExtendedRequest, res: Response) => {
        try {
            const {
                email,
                phone_number,
                given_name,
                family_name
            } = req.body

            if (!email || !isValidEmail(email)) {
                throw {
                    status: 401,
                    message: 'Invalid or missing email'
                }
            }
            if (!phone_number || !isValidPhoneNumber(phone_number)) {
                throw {
                    status: 401,
                    message: 'Invalid or missing phone number'
                }
            }
            if (!given_name || !isValidString(given_name)) {
                throw {
                    status: 401,
                    message: 'Invalid or missing given name'
                }
            }
            if (!family_name || !isValidString(family_name)) {
                throw {
                    status: 401,
                    message: 'Invalid or missing family name'
                }
            }


            const findDuplicates = await DB.query('SELECT phone_number,email FROM Admin WHERE phone_number = :phone_number OR email = :email;', {
                email: email,
                phone_number: phone_number,
            })

            if (findDuplicates.length >= 1) {
                const duplicate = findDuplicates[0];

                if (email == duplicate.email && phone_number == duplicate.phone_number) {
                    throw {
                        status: 401,
                        message: 'This email and phone_number already exists'
                    }
                }
                if (phone_number == duplicate.phone_number) {
                    throw {
                        status: 401,
                        message: 'This phone_number already exists'
                    }
                } else {
                    throw {
                        status: 401,
                        message: 'This email already exists'
                    }
                }
            }

            const admin = await this.cognitoClient.register(email)

            const adminInsert = await DB.execute(`INSERT INTO Admin 
                (cognito_sub_id, email, phone_number, given_name, family_name
                    , created_at, last_login_at, permissions, school_id) VALUES 
                    (:cognito_sub_id, :email, :phone_number, :given_name, :family_name
                    , NOW(), NOW(), '{}', :school_id) `, {
                cognito_sub_id: admin.sub_id,
                email: email,
                phone_number: phone_number,
                given_name: given_name,
                family_name: family_name,
                school_id: req.user.school_id,
            });

            return res.status(200).json({
                admin: {
                    id: adminInsert.insertId,
                    email: email,
                    phone_number: phone_number,
                    given_name: given_name,
                    family_name: family_name,
                }
            }).end()
        } catch (e: any) {
            if (e.status) {
                return res.status(e.status).json({
                    error: e.message
                }).end();
            } else {
                return res.status(500).json({
                    error: 'Internal server error'
                }).end();
            }
        }
    }
}

export default AdminController